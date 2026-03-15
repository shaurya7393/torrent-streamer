import express from 'express';
import WebTorrent from 'webtorrent';
import mime from 'mime';
import rangeParser from 'range-parser';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseUtils, models } from './src/database.js';
import { dlnaManager } from './src/dlna.js';
import { airplayManager } from './src/airplay.js';
import { rtpStreamer } from './src/rtp-streamer.js';
import { sapAnnouncer } from './src/sap-announcer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// serve the simple UI
app.use(express.static(path.join(__dirname, 'public')));
// serve Metronic assets
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

const client = new WebTorrent();
let active = {
	torrent: null,
	file: null,
	fileIndex: null,
	movieId: null,
	sessionId: null,
	metadata: {
		title: null,
		quality: null,
		year: null,
	},
};

// Initialize database
async function initializeApp() {
	try {
		await DatabaseUtils.initialize();
		dlnaManager.initialize();
		await airplayManager.init();
		sapAnnouncer.initialize();
		console.log('✅ Application initialized successfully');
	} catch (error) {
		console.error('❌ Failed to initialize application:', error.message);
		process.exit(1);
	}
}

// Start streaming a magnet/torrent
app.post('/start', async (req, res) => {
	const { magnet, title, quality, year } = req.body || {};
	if (!magnet) return res.status(400).json({ error: 'magnet required' });

	try {
		// stop previous torrent if any
		if (active.torrent) {
			try {
				if (active.sessionId) {
					await DatabaseUtils.endActiveSession(active.sessionId);
				}
				active.torrent.destroy();
			} catch {}
			active = {
				torrent: null,
				file: null,
				fileIndex: null,
				movieId: null,
				sessionId: null,
				metadata: { title: null, quality: null, year: null },
			};
		}

		// Add or get movie from database
		const movieData = {
			magnetUri: magnet,
			title: title || 'Unknown Movie',
			quality: quality || 'Unknown',
			year: year || null,
			status: 'downloading',
		};

		const movie = await DatabaseUtils.addMovie(movieData);

		// Check if torrent is already in the client (by infoHash or magnetURI)
		const existingTorrent = client.torrents.find(
			(t) =>
				t.magnetURI === magnet ||
				t.infoHash === magnet.match(/btih:([a-f0-9]{40})/i)?.[1],
		);

		if (existingTorrent) {
			console.log(
				'⚠️  Torrent already exists, reusing:',
				existingTorrent.infoHash,
			);

			// Use existing torrent
			const file =
				existingTorrent.files
					.filter((f) => /\.(mp4|mkv|mov|avi|webm|m4v)$/i.test(f.name))
					.sort((a, b) => b.length - a.length)[0] || existingTorrent.files[0];

			const sessionData = {
				userAgent: req.headers['user-agent'],
				ipAddress: req.ip || req.connection.remoteAddress,
				platform: 'web',
			};
			const session = await DatabaseUtils.createActiveSession(
				movie.id,
				sessionData,
			);

			active = {
				torrent: existingTorrent,
				file,
				fileIndex: existingTorrent.files.indexOf(file),
				movieId: movie.id,
				sessionId: session.sessionId,
				metadata: {
					title: movie.title,
					quality: movie.quality,
					year: movie.year,
				},
			};

			return res.json({
				ok: true,
				movieId: movie.id,
				sessionId: session.sessionId,
				infoHash: existingTorrent.infoHash,
				name: file.name,
				title: movie.title,
				message: 'Using existing torrent',
				stream_url: '/stream',
				files_url: '/files',
			});
		}
		// Add timeout to handle cases where callback never fires
		// Add timeout to handle cases where callback never fires
		let responseHandled = false;
		const timeoutId = setTimeout(() => {
			if (!res.headersSent && !responseHandled) {
				responseHandled = true;
				console.error(
					'Torrent add timeout - callback not fired within 60 seconds',
				);
				res.status(500).json({
					error:
						'Torrent initialization timeout. The torrent may take longer to start. Please try again.',
				});
			}
		}, 60000);

		const torrentInstance = client.add(
			magnet,
			{ path: './data' },
			async (torrent) => {
				try {
					// Set up error handler first
					torrent.on('error', async (error) => {
						console.error('Torrent error:', error.message);
						try {
							await DatabaseUtils.updateMovieStatus(movie.id, 'error');
						} catch {}
					});

					// Reload movie to get current infoHash value
					await movie.reload();
					console.log(
						'🔍 Movie infoHash:',
						movie.infoHash,
						'Torrent infoHash:',
						torrent.infoHash,
					);

					// Update movie with torrent info (skip infoHash if already set to avoid unique constraint)
					const updateData = { downloadProgress: 0 };
					if (!movie.infoHash || movie.infoHash !== torrent.infoHash) {
						console.log('➕ Adding infoHash to update');
						updateData.infoHash = torrent.infoHash;
					} else {
						console.log('⏭️  Skipping infoHash - already set');
					}
					await DatabaseUtils.updateMovieStatus(
						movie.id,
						'downloading',
						updateData,
					);

					// choose largest video file by default
					const pick = (files) =>
						files
							.filter((f) => /\.(mp4|mkv|mov|avi|webm|m4v)$/i.test(f.name))
							.sort((a, b) => b.length - a.length)[0] || files[0];

					const file = pick(torrent.files);
					const fileIndex = torrent.files.indexOf(file);

					// Update movie with file info
					await DatabaseUtils.updateMovieStatus(movie.id, 'ready', {
						filePath: file?.name,
						fileSize: file?.length,
						seeders: torrent.numPeers,
						downloadProgress: torrent.progress * 100,
					});

					// Create active session
					const sessionData = {
						userAgent: req.headers['user-agent'],
						ipAddress: req.ip || req.connection.remoteAddress,
						platform: 'web',
					};

					const session = await DatabaseUtils.createActiveSession(
						movie.id,
						sessionData,
					);

					active = {
						torrent,
						file,
						fileIndex,
						movieId: movie.id,
						sessionId: session.sessionId,
						metadata: {
							title: movie.title,
							quality: movie.quality,
							year: movie.year,
						},
					};

					// nudge priority on chosen file
					try {
						file.select();
					} catch {}

					// Track download progress
					torrent.on('download', async () => {
						try {
							const progress = torrent.progress * 100;
							await DatabaseUtils.updateMovieProgress(movie.id, progress);

							if (active.sessionId) {
								await DatabaseUtils.updateActiveSession(active.sessionId, {
									bufferHealth: progress,
									downloadSpeed: torrent.downloadSpeed / (1024 * 1024), // MB/s
								});
							}
						} catch (err) {
							console.error('Error updating progress:', err.message);
						}
					});

					// Clear timeout since we got the callback
					clearTimeout(timeoutId);

					if (!res.headersSent && !responseHandled) {
						responseHandled = true;
						res.json({
							ok: true,
							movieId: movie.id,
							sessionId: session.sessionId,
							infoHash: torrent.infoHash,
							name: file ? file.name : torrent.name,
							title: movie.title,
							size: file ? file.length : null,
							progress: torrent.progress * 100,
							stream_url: '/stream',
							files_url: '/files',
						});
					}
				} catch (error) {
					console.error('Error setting up torrent:', error.message);
					console.error('Error stack:', error.stack);
					clearTimeout(timeoutId);
					if (!res.headersSent) {
						res.status(500).json({
							error: 'Failed to setup torrent',
							details: error.message,
						});
					}
				}
			},
		);

		// Handle client.add() errors - client.add returns undefined initially
		client.on('error', async (error) => {
			console.error('WebTorrent client error:', error.message);
			try {
				await DatabaseUtils.updateMovieStatus(movie.id, 'error');
			} catch {}
			if (!res.headersSent) {
				res
					.status(500)
					.json({ error: 'WebTorrent client error', details: error.message });
			}
		});
	} catch (error) {
		console.error('Error starting torrent:', error.message);
		console.error('Error stack:', error.stack);
		if (!res.headersSent) {
			res
				.status(500)
				.json({ error: 'Failed to start torrent', details: error.message });
		}
	}
});

// Stop and cleanup
app.post('/stop', async (_req, res) => {
	try {
		if (!active.torrent) return res.json({ stopped: true });

		// End active session if exists
		if (active.sessionId) {
			await DatabaseUtils.endActiveSession(active.sessionId);
		}

		active.torrent.destroy(() => {
			active = {
				torrent: null,
				file: null,
				fileIndex: null,
				movieId: null,
				sessionId: null,
				metadata: { title: null, quality: null, year: null },
			};
			res.json({ stopped: true });
		});
	} catch (error) {
		console.error('Error stopping torrent:', error.message);
		res.status(500).json({ error: 'Failed to stop torrent' });
	}
});

// List files in the current torrent (for selection)
app.get('/files', (_req, res) => {
	if (!active.torrent) return res.json({ files: [] });
	const files = active.torrent.files.map((f, idx) => ({
		index: idx,
		name: f.name,
		size: f.length,
	}));
	res.json({
		files,
		selectedIndex: active.fileIndex,
	});
});

// Select a specific file by index
app.post('/select', (req, res) => {
	const { index } = req.body || {};
	if (!active.torrent)
		return res.status(400).json({ error: 'no active torrent' });
	if (
		index == null ||
		isNaN(index) ||
		index < 0 ||
		index >= active.torrent.files.length
	) {
		return res.status(400).json({ error: 'invalid index' });
	}
	// deselect all, select chosen
	active.torrent.files.forEach((f) => {
		try {
			f.deselect();
		} catch {}
	});
	const file = active.torrent.files[index];
	try {
		file.select();
	} catch {}
	active.file = file;
	active.fileIndex = index;
	res.json({
		ok: true,
		name: file.name,
		size: file.length,
		stream_url: '/stream',
	});
});

// Status endpoint
app.get('/status', async (_req, res) => {
	try {
		if (!active.torrent) return res.json({ running: false });

		const t = active.torrent;
		const status = {
			running: true,
			title: active.metadata?.title || active.file?.name,
			name: active.file?.name,
			infoHash: t.infoHash,
			progress: Number((t.progress * 100).toFixed(2)),
			downloadSpeed: Number((t.downloadSpeed / (1024 * 1024)).toFixed(2)),
			uploadSpeed: Number((t.uploadSpeed / (1024 * 1024)).toFixed(2)),
			peers: t.numPeers,
			selectedIndex: active.fileIndex,
			movieId: active.movieId,
			sessionId: active.sessionId,
		};

		// Update session with current stats
		if (active.sessionId) {
			await DatabaseUtils.updateActiveSession(active.sessionId, {
				downloadSpeed: t.downloadSpeed / (1024 * 1024), // MB/s
				uploadSpeed: t.uploadSpeed / (1024 * 1024), // MB/s
				bufferHealth: t.progress * 100,
			});
		}

		res.json(status);
	} catch (error) {
		console.error('Error getting status:', error.message);
		res.status(500).json({ error: 'Failed to get status' });
	}
});

// Database API Endpoints

// Get dashboard statistics
app.get('/api/dashboard', async (_req, res) => {
	try {
		const stats = await DatabaseUtils.getDashboardStats();
		res.json(stats);
	} catch (error) {
		console.error('Error getting dashboard stats:', error.message);
		res.status(500).json({ error: 'Failed to get dashboard stats' });
	}
});

// Get all movies
app.get('/api/movies', async (req, res) => {
	try {
		const { status, limit = 50, offset = 0 } = req.query;

		const whereClause = status ? { status } : {};
		const movies = await models.Movie.findAll({
			where: whereClause,
			limit: parseInt(limit),
			offset: parseInt(offset),
			order: [['createdAt', 'DESC']],
			include: [
				{ model: models.Bookmark, as: 'bookmarks' },
				{
					model: models.WatchHistory,
					as: 'watchHistory',
					limit: 1,
					order: [['watchedAt', 'DESC']],
				},
			],
		});

		res.json(movies);
	} catch (error) {
		console.error('Error getting movies:', error.message);
		res.status(500).json({ error: 'Failed to get movies' });
	}
});

// Get recently watched movies
app.get('/api/movies/recent', async (_req, res) => {
	try {
		const recentMovies = await models.Movie.getRecentlyWatched(10);
		res.json(recentMovies);
	} catch (error) {
		console.error('Error getting recent movies:', error.message);
		res.status(500).json({ error: 'Failed to get recent movies' });
	}
});

// Get bookmarked movies
app.get('/api/movies/bookmarks', async (_req, res) => {
	try {
		const bookmarks = await models.Bookmark.getFavorites();
		res.json(bookmarks);
	} catch (error) {
		console.error('Error getting bookmarks:', error.message);
		res.status(500).json({ error: 'Failed to get bookmarks' });
	}
});

// Toggle bookmark for a movie
app.post('/api/movies/:id/bookmark', async (req, res) => {
	try {
		const { id } = req.params;
		const { notes, category = 'general' } = req.body;

		const bookmark = await DatabaseUtils.toggleBookmark(parseInt(id), {
			notes,
			category,
		});

		res.json({
			bookmarked: bookmark !== null,
			bookmark,
		});
	} catch (error) {
		console.error('Error toggling bookmark:', error.message);
		res.status(500).json({ error: 'Failed to toggle bookmark' });
	}
});

// Get active sessions
app.get('/api/sessions', async (_req, res) => {
	try {
		const sessions = await models.ActiveSession.getActiveSessions();
		res.json(sessions);
	} catch (error) {
		console.error('Error getting active sessions:', error.message);
		res.status(500).json({ error: 'Failed to get active sessions' });
	}
});

// Update playback progress
app.post('/api/sessions/:sessionId/progress', async (req, res) => {
	try {
		const { sessionId } = req.params;
		const { currentTime, duration, status } = req.body;

		await DatabaseUtils.updateActiveSession(sessionId, {
			currentTime,
			duration,
			status,
		});

		// Also create/update watch history
		const session = await models.ActiveSession.getSessionById(sessionId);
		if (session) {
			await DatabaseUtils.updateWatchProgress(sessionId, currentTime, duration);
		}

		res.json({ ok: true });
	} catch (error) {
		console.error('Error updating progress:', error.message);
		res.status(500).json({ error: 'Failed to update progress' });
	}
});

// Database health check
app.get('/api/health', async (_req, res) => {
	try {
		const health = await DatabaseUtils.healthCheck();
		res.json(health);
	} catch (error) {
		console.error('Error checking health:', error.message);
		res.status(500).json({ error: 'Failed to check health' });
	}
});

// Stream endpoint (supports HTTP range for VLC / players)
app.get('/stream', (req, res) => {
	if (!active.file) return res.status(404).end('No active file');

	const file = active.file;
	const mimeType = mime.getType(file.name) || 'application/octet-stream';
	const total = file.length;

	// Prepare metadata headers
	const { title, quality, year } = active.metadata;
	const safeTitle = title ? title.replace(/[^a-zA-Z0-9-_ ]/g, '') : 'stream';
	const extension = path.extname(file.name);
	const filename = `${safeTitle}${extension}`;

	// Handle client disconnection
	req.on('close', () => {
		console.log('Client disconnected from stream');
	});

	res.on('error', (err) => {
		console.log('Stream error:', err.message);
	});

	// Parse Range header for partial content
	const parsed = req.headers.range ? rangeParser(total, req.headers.range) : -1;
	const range = Array.isArray(parsed) ? parsed[0] : null;

	if (range) {
		const { start, end } = range;
		res.writeHead(206, {
			'Content-Range': `bytes ${start}-${end}/${total}`,
			'Accept-Ranges': 'bytes',
			'Content-Length': end - start + 1,
			'Content-Type': mimeType,
			'Content-Disposition': `inline; filename="${filename}"`,
			'X-Movie-Title': title || 'Unknown',
			'X-Movie-Quality': quality || 'Unknown',
			'X-Movie-Year': year || '',
			'Cache-Control': 'no-store',
		});

		const stream = file.createReadStream({ start, end });
		stream.on('error', (err) => {
			console.log('File stream error:', err.message);
			if (!res.headersSent) {
				res.status(500).end('Stream error');
			}
		});

		stream.pipe(res);
	} else {
		res.writeHead(200, {
			'Content-Length': total,
			'Content-Type': mimeType,
			'Content-Disposition': `inline; filename="${filename}"`,
			'X-Movie-Title': title || 'Unknown',
			'X-Movie-Quality': quality || 'Unknown',
			'X-Movie-Year': year || '',
			'Accept-Ranges': 'bytes',
			'Cache-Control': 'no-store',
		});

		const stream = file.createReadStream();
		stream.on('error', (err) => {
			console.log('File stream error:', err.message);
			if (!res.headersSent) {
				res.status(500).end('Stream error');
			}
		});

		stream.pipe(res);
	}
});

// ========== DLNA Endpoints ==========

// Get available DLNA devices
app.get('/api/dlna/devices', (req, res) => {
	try {
		const devices = dlnaManager.getDevices();
		res.json({
			success: true,
			devices,
			count: devices.length,
		});
	} catch (error) {
		console.error('Error getting DLNA devices:', error.message);
		res.status(500).json({ error: 'Failed to get DLNA devices' });
	}
});

// Cast current stream to a DLNA device
app.post('/api/dlna/cast', async (req, res) => {
	const { deviceId } = req.body;

	if (!deviceId) {
		return res.status(400).json({ error: 'deviceId required' });
	}

	if (!active.file) {
		return res.status(400).json({ error: 'No active stream to cast' });
	}

	try {
		// Construct stream URL - use the request host or a configured host
		const host = req.headers.host || `localhost:${PORT}`;
		const streamUrl = `http://${host}/stream`;

		const metadata = {
			title: active.metadata.title || 'Torrent Stream',
			quality: active.metadata.quality,
			year: active.metadata.year,
			contentType: mime.getType(active.file.name) || 'video/mp4',
		};

		// Add subtitles if available
		const subtitles = findSubtitles(active.torrent, active.file);
		metadata.subtitles = subtitles.map((sub) => ({
			url: `http://${host}/subtitles/${sub.index}`,
			language: sub.language,
			name: sub.name,
		}));

		const result = await dlnaManager.cast(deviceId, streamUrl, metadata);
		res.json(result);
	} catch (error) {
		console.error('Error casting to DLNA device:', error.message);
		res.status(500).json({ error: error.message });
	}
});

// Control DLNA playback
app.post('/api/dlna/control', async (req, res) => {
	const { action, position } = req.body;

	if (!action) {
		return res
			.status(400)
			.json({ error: 'action required (play, pause, stop, seek)' });
	}

	try {
		switch (action) {
			case 'play':
				await dlnaManager.play();
				break;
			case 'pause':
				await dlnaManager.pause();
				break;
			case 'stop':
				await dlnaManager.stop();
				break;
			case 'seek':
				if (typeof position !== 'number') {
					return res
						.status(400)
						.json({ error: 'position (in seconds) required for seek' });
				}
				await dlnaManager.seek(position);
				break;
			default:
				return res
					.status(400)
					.json({ error: 'Invalid action. Use: play, pause, stop, or seek' });
		}

		res.json({ success: true, action, status: dlnaManager.getStatus() });
	} catch (error) {
		console.error('Error controlling DLNA playback:', error.message);
		res.status(500).json({ error: error.message });
	}
});

// Get DLNA casting status
app.get('/api/dlna/status', (req, res) => {
	try {
		const status = dlnaManager.getStatus();
		res.json({ success: true, ...status });
	} catch (error) {
		console.error('Error getting DLNA status:', error.message);
		res.status(500).json({ error: 'Failed to get DLNA status' });
	}
});

// ===== AirPlay Endpoints =====
// Get AirPlay devices
app.get('/api/airplay/devices', (req, res) => {
	try {
		const devices = airplayManager.getDevices();
		res.json({
			success: true,
			devices,
			count: devices.length,
		});
	} catch (error) {
		console.error('Error getting AirPlay devices:', error.message);
		res.status(500).json({ error: 'Failed to get AirPlay devices' });
	}
});

// Cast to AirPlay device
app.post('/api/airplay/cast', async (req, res) => {
	const { deviceId } = req.body;

	if (!deviceId) {
		return res.status(400).json({ error: 'deviceId required' });
	}

	if (!active.file) {
		return res.status(400).json({ error: 'No active stream to cast' });
	}

	try {
		// Construct stream URL
		const host = req.headers.host || `localhost:${PORT}`;
		const streamUrl = `http://${host}/stream`;

		const metadata = {
			title: active.metadata.title || 'Torrent Stream',
			quality: active.metadata.quality,
			year: active.metadata.year,
			contentType: mime.getType(active.file.name) || 'video/mp4',
		};

		// Add subtitles if available
		const subtitles = findSubtitles(active.torrent, active.file);
		metadata.subtitles = subtitles.map((sub) => ({
			url: `http://${host}/subtitles/${sub.index}`,
			language: sub.language,
			name: sub.name,
		}));

		const result = await airplayManager.cast(deviceId, streamUrl, metadata);
		res.json(result);
	} catch (error) {
		console.error('Error casting to AirPlay device:', error.message);
		res.status(500).json({ error: error.message });
	}
});

// Control AirPlay playback
app.post('/api/airplay/control', async (req, res) => {
	const { action, position, level } = req.body;

	if (!action) {
		return res
			.status(400)
			.json({ error: 'action required (play, pause, stop, seek, volume)' });
	}

	try {
		const result = await airplayManager.control(action, { position, level });
		res.json(result);
	} catch (error) {
		console.error('Error controlling AirPlay device:', error.message);
		res.status(500).json({ error: error.message });
	}
});

// Get AirPlay status
app.get('/api/airplay/status', (req, res) => {
	try {
		const status = airplayManager.getStatus();
		res.json(status);
	} catch (error) {
		console.error('Error getting AirPlay status:', error.message);
		res.status(500).json({ error: 'Failed to get AirPlay status' });
	}
});

// Get playback info
app.get('/api/airplay/playback-info', async (req, res) => {
	try {
		const info = await airplayManager.getPlaybackInfo();
		res.json(info);
	} catch (error) {
		console.error('Error getting playback info:', error.message);
		res.status(500).json({ error: 'Failed to get playback info' });
	}
});

// ========== RTP/UDP Streaming Endpoints ==========

// Get all available streaming protocols
app.get('/api/streaming/protocols', async (req, res) => {
	try {
		const ffmpegAvailable = await rtpStreamer.checkFFmpeg();

		res.json({
			success: true,
			protocols: {
				http: {
					available: true,
					endpoint: '/stream',
					description: 'HTTP streaming with range support',
				},
				dlna: {
					available: true,
					endpoint: '/api/dlna',
					description: 'DLNA casting to network devices',
				},
				rtp: {
					available: ffmpegAvailable,
					endpoint: '/api/rtp',
					description: 'RTP streaming (requires FFmpeg)',
					requiresFFmpeg: true,
				},
				udp: {
					available: ffmpegAvailable,
					endpoint: '/api/udp',
					description: 'UDP multicast streaming (requires FFmpeg)',
					requiresFFmpeg: true,
				},
			},
			ffmpegAvailable,
		});
	} catch (error) {
		console.error('Error checking protocols:', error.message);
		res.status(500).json({ error: 'Failed to check protocols' });
	}
});

// Start RTP stream
app.post('/api/rtp/start', async (req, res) => {
	if (!active.file) {
		return res.status(400).json({ error: 'No active stream available' });
	}

	const ffmpegAvailable = await rtpStreamer.checkFFmpeg();
	if (!ffmpegAvailable) {
		return res.status(503).json({
			error: 'FFmpeg not installed',
			message:
				'Please install FFmpeg to use RTP streaming: sudo apt-get install ffmpeg',
		});
	}

	try {
		const { port, multicast, enableSAP } = req.body;

		const options = {
			port: port || 5004,
			multicast: multicast !== false,
		};

		const streamInfo = await rtpStreamer.startRTPStream(
			active.file,
			active.metadata,
			options,
		);

		// Announce via SAP if enabled
		if (enableSAP !== false) {
			const sapInfo = {
				...streamInfo,
				title: active.metadata.title || 'Torrent Stream',
				quality: active.metadata.quality,
				description: `Streaming: ${active.metadata.title || 'Unknown'}`,
			};
			sapAnnouncer.announce(sapInfo);
		}

		res.json({
			success: true,
			...streamInfo,
			message: 'RTP stream started',
			vlcCommand: `vlc ${streamInfo.url}`,
		});
	} catch (error) {
		console.error('Error starting RTP stream:', error.message);
		res.status(500).json({ error: error.message });
	}
});

// Stop RTP stream
app.post('/api/rtp/stop', async (req, res) => {
	try {
		const { streamId } = req.body;

		if (!streamId) {
			return res.status(400).json({ error: 'streamId required' });
		}

		rtpStreamer.stopStream(streamId);
		sapAnnouncer.stopAnnouncement(streamId);

		res.json({ success: true, message: 'RTP stream stopped' });
	} catch (error) {
		console.error('Error stopping RTP stream:', error.message);
		res.status(500).json({ error: error.message });
	}
});

// Get RTP stream status
app.get('/api/rtp/status', (req, res) => {
	try {
		const streams = rtpStreamer.getAllStreams();
		const sapAnnouncements = sapAnnouncer.getActiveAnnouncements();

		res.json({
			success: true,
			streams,
			activeStreams: streams.length,
			sapAnnouncements,
		});
	} catch (error) {
		console.error('Error getting RTP status:', error.message);
		res.status(500).json({ error: 'Failed to get RTP status' });
	}
});

// Start UDP stream
app.post('/api/udp/start', async (req, res) => {
	if (!active.file) {
		return res.status(400).json({ error: 'No active stream available' });
	}

	const ffmpegAvailable = await rtpStreamer.checkFFmpeg();
	if (!ffmpegAvailable) {
		return res.status(503).json({
			error: 'FFmpeg not installed',
			message:
				'Please install FFmpeg to use UDP streaming: sudo apt-get install ffmpeg',
		});
	}

	try {
		const { port, multicastAddr, enableSAP } = req.body;

		const options = {
			port: port || 1234,
			multicastAddr: multicastAddr || '239.255.1.1',
		};

		const streamInfo = await rtpStreamer.startUDPStream(
			active.file,
			active.metadata,
			options,
		);

		// Announce via SAP if enabled
		if (enableSAP !== false) {
			const sapInfo = {
				...streamInfo,
				title: active.metadata.title || 'Torrent Stream',
				quality: active.metadata.quality,
				description: `Streaming: ${active.metadata.title || 'Unknown'}`,
			};
			sapAnnouncer.announce(sapInfo);
		}

		res.json({
			success: true,
			...streamInfo,
			message: 'UDP stream started',
			vlcCommand: `vlc ${streamInfo.url}`,
		});
	} catch (error) {
		console.error('Error starting UDP stream:', error.message);
		res.status(500).json({ error: error.message });
	}
});

// Stop UDP stream
app.post('/api/udp/stop', async (req, res) => {
	try {
		const { streamId } = req.body;

		if (!streamId) {
			return res.status(400).json({ error: 'streamId required' });
		}

		rtpStreamer.stopStream(streamId);
		sapAnnouncer.stopAnnouncement(streamId);

		res.json({ success: true, message: 'UDP stream stopped' });
	} catch (error) {
		console.error('Error stopping UDP stream:', error.message);
		res.status(500).json({ error: error.message });
	}
});

// Get UDP stream status
app.get('/api/udp/status', (req, res) => {
	try {
		const streams = rtpStreamer
			.getAllStreams()
			.filter((s) => s.id.startsWith('udp-'));
		const sapAnnouncements = sapAnnouncer.getActiveAnnouncements();

		res.json({
			success: true,
			streams,
			activeStreams: streams.length,
			sapAnnouncements,
		});
	} catch (error) {
		console.error('Error getting UDP status:', error.message);
		res.status(500).json({ error: 'Failed to get UDP status' });
	}
});

// Basic health check
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Graceful shutdown
const shutdown = () => {
	console.log('\nShutting down…');
	if (active.torrent) {
		dlnaManager.destroy();
		rtpStreamer.stopAllStreams();
		sapAnnouncer.destroy();
		try {
			active.torrent.destroy();
		} catch {}
	}
	client.destroy(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const PORT = 8881;

// Start the application
async function startServer() {
	await initializeApp();

	app.listen(PORT, '0.0.0.0', () => {
		console.log(`🚀 Torrent Streamer running on http://0.0.0.0:${PORT}`);
		console.log(`📊 Dashboard: http://0.0.0.0:${PORT}`);
		console.log(`🔧 API: http://0.0.0.0:${PORT}/api/health`);
	});
}

startServer().catch((error) => {
	console.error('❌ Failed to start server:', error.message);
	process.exit(1);
});

// ===== Subtitle Support =====

// Detect subtitle files in torrent
function findSubtitles(torrent, videoFile) {
	const subtitleExts = ['.srt', '.vtt', '.sub', '.ass', '.ssa'];
	const videoBaseName = videoFile.name.replace(/\.[^/.]+$/, ''); // Remove extension

	const subtitles = torrent.files.filter((file) => {
		const ext = path.extname(file.name).toLowerCase();
		if (!subtitleExts.includes(ext)) return false;

		// Check if filename is similar to video file
		const subBaseName = file.name.replace(/\.[^/.]+$/, '');
		return (
			subBaseName.includes(videoBaseName) || videoBaseName.includes(subBaseName)
		);
	});

	return subtitles.map((file, index) => ({
		index: torrent.files.indexOf(file),
		name: file.name,
		language: detectLanguage(file.name),
		size: file.length,
	}));
}

// Simple language detection from filename
function detectLanguage(filename) {
	const langPatterns = {
		en: /\.(en|eng|english)\./i,
		es: /\.(es|spa|spanish)\./i,
		fr: /\.(fr|fre|french)\./i,
		de: /\.(de|ger|german)\./i,
		it: /\.(it|ita|italian)\./i,
		pt: /\.(pt|por|portuguese)\./i,
		ru: /\.(ru|rus|russian)\./i,
		ja: /\.(ja|jpn|japanese)\./i,
		ko: /\.(ko|kor|korean)\./i,
		zh: /\.(zh|chi|chinese)\./i,
		ar: /\.(ar|ara|arabic)\./i,
	};

	for (const [code, pattern] of Object.entries(langPatterns)) {
		if (pattern.test(filename)) return code;
	}

	return 'unknown';
}

// Get available subtitles for current stream
app.get('/api/subtitles', (req, res) => {
	if (!active.torrent || !active.file) {
		return res.json({ subtitles: [] });
	}

	try {
		const subtitles = findSubtitles(active.torrent, active.file);
		res.json({ success: true, subtitles });
	} catch (error) {
		console.error('Error finding subtitles:', error.message);
		res.status(500).json({ error: 'Failed to find subtitles' });
	}
});

// Stream subtitle file
app.get('/subtitles/:index', (req, res) => {
	const index = parseInt(req.params.index);

	if (!active.torrent) {
		return res.status(404).json({ error: 'No active torrent' });
	}

	const file = active.torrent.files[index];
	if (!file) {
		return res.status(404).json({ error: 'Subtitle file not found' });
	}

	try {
		const ext = path.extname(file.name).toLowerCase();
		const contentTypes = {
			'.srt': 'text/srt',
			'.vtt': 'text/vtt',
			'.sub': 'text/plain',
			'.ass': 'text/x-ssa',
			'.ssa': 'text/x-ssa',
		};

		res.setHeader('Content-Type', contentTypes[ext] || 'text/plain');
		res.setHeader('Content-Disposition', `inline; filename="${file.name}"`);
		res.setHeader('Access-Control-Allow-Origin', '*');

		const stream = file.createReadStream();
		stream.pipe(res);

		stream.on('error', (error) => {
			console.error('Subtitle stream error:', error.message);
			if (!res.headersSent) {
				res.status(500).json({ error: 'Subtitle streaming failed' });
			}
		});

		console.log(`📄 Streaming subtitle: ${file.name}`);
	} catch (error) {
		console.error('Error streaming subtitle:', error.message);
		res.status(500).json({ error: 'Failed to stream subtitle' });
	}
});

// ===== Library & History Endpoints =====

// Get library with filters
app.get('/api/library', async (req, res) => {
	try {
		const {
			status,
			bookmarked,
			search,
			limit = 50,
			offset = 0,
			sortBy = 'createdAt',
			sortOrder = 'DESC',
		} = req.query;

		const where = {};

		if (status) where.status = status;
		if (bookmarked === 'true') where.isBookmarked = true;
		if (search) {
			where[Sequelize.Op.or] = [
				{ title: { [Sequelize.Op.like]: `%${search}%` } },
				{ description: { [Sequelize.Op.like]: `%${search}%` } },
			];
		}

		const movies = await models.Movie.findAll({
			where,
			limit: parseInt(limit),
			offset: parseInt(offset),
			order: [[sortBy, sortOrder]],
		});

		const total = await models.Movie.count({ where });

		res.json({
			success: true,
			movies: movies.map((m) => ({
				id: m.id,
				title: m.title,
				year: m.year,
				quality: m.quality,
				genre: m.genre,
				status: m.status,
				poster: m.poster,
				downloadProgress: m.downloadProgress,
				isBookmarked: m.isBookmarked,
				lastWatched: m.lastWatched,
				watchCount: m.watchCount,
				duration: m.duration,
				fileSize: m.fileSize,
				createdAt: m.createdAt,
			})),
			total,
			limit: parseInt(limit),
			offset: parseInt(offset),
		});
	} catch (error) {
		console.error('Error getting library:', error.message);
		res.status(500).json({ error: 'Failed to get library' });
	}
});

// Get watch history
app.get('/api/history', async (req, res) => {
	try {
		const { limit = 20, offset = 0 } = req.query;

		const history = await models.WatchHistory.findAll({
			limit: parseInt(limit),
			offset: parseInt(offset),
			order: [['watchedAt', 'DESC']],
			include: [
				{
					model: models.Movie,
					attributes: ['title', 'quality', 'year', 'poster'],
				},
			],
		});

		const total = await models.WatchHistory.count();

		res.json({
			success: true,
			history: history.map((h) => ({
				id: h.id,
				movieId: h.movieId,
				movie: h.Movie,
				watchedAt: h.watchedAt,
				duration: h.duration,
				position: h.position,
				completed: h.completed,
			})),
			total,
			limit: parseInt(limit),
			offset: parseInt(offset),
		});
	} catch (error) {
		// Delete watch history
		app.delete('/api/history', async (req, res) => {
			try {
				await models.WatchHistory.destroy({
					where: {},
					truncate: true,
				});

				res.json({
					success: true,
					message: 'Watch history cleared',
				});
			} catch (error) {
				console.error('Error clearing watch history:', error);
				res.status(500).json({
					success: false,
					error: 'Failed to clear watch history',
				});
			}
		});
		console.error('Error getting history:', error.message);
		res.status(500).json({ error: 'Failed to get history' });
	}
});

// Toggle bookmark
app.post('/api/movies/:id/bookmark', async (req, res) => {
	try {
		const movieId = parseInt(req.params.id);
		const movie = await models.Movie.findByPk(movieId);

		if (!movie) {
			return res.status(404).json({ error: 'Movie not found' });
		}

		await movie.toggleBookmark();

		res.json({
			success: true,
			isBookmarked: movie.isBookmarked,
		});
	} catch (error) {
		console.error('Error toggling bookmark:', error.message);
		res.status(500).json({ error: 'Failed to toggle bookmark' });
	}
});

// Get movie details
app.get('/api/movies/:id', async (req, res) => {
	try {
		const movieId = parseInt(req.params.id);
		const movie = await models.Movie.findByPk(movieId);

		if (!movie) {
			return res.status(404).json({ error: 'Movie not found' });
		}

		res.json({
			success: true,
			movie: {
				id: movie.id,
				title: movie.title,
				year: movie.year,
				quality: movie.quality,
				genre: movie.genre,
				description: movie.description,
				poster: movie.poster,
				imdbId: movie.imdbId,
				status: movie.status,
				magnetUri: movie.magnetUri,
				infoHash: movie.infoHash,
				filePath: movie.filePath,
				fileSize: movie.fileSize,
				duration: movie.duration,
				downloadProgress: movie.downloadProgress,
				seeders: movie.seeders,
				leechers: movie.leechers,
				isBookmarked: movie.isBookmarked,
				lastWatched: movie.lastWatched,
				watchCount: movie.watchCount,
				tags: movie.tags,
				createdAt: movie.createdAt,
				updatedAt: movie.updatedAt,
			},
		});
	} catch (error) {
		console.error('Error getting movie:', error.message);
		res.status(500).json({ error: 'Failed to get movie' });
	}
});

// Resume from last position
app.post('/api/movies/:id/resume', async (req, res) => {
	try {
		const movieId = parseInt(req.params.id);

		const lastHistory = await models.WatchHistory.findOne({
			where: { movieId },
			order: [['watchedAt', 'DESC']],
		});

		if (!lastHistory || !lastHistory.position) {
			return res.status(404).json({ error: 'No watch history found' });
		}

		res.json({
			success: true,
			position: lastHistory.position,
			duration: lastHistory.duration,
		});
	} catch (error) {
		console.error('Error getting resume position:', error.message);
		res.status(500).json({ error: 'Failed to get resume position' });
	}
});
