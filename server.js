import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { nanoid } from 'nanoid';
import UAParser from 'ua-parser-js';
import geoip from 'geoip-lite';
import multer from 'multer';
import crypto from 'crypto';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
const corsOptions = {
  origin: process.env.CORS_ORIGINS 
    ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim())
    : ['https://h4a.us', 'https://www.h4a.us', 'http://localhost:3000'],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());

// MongoDB connection options optimized for serverless
// These are MongoDB driver options (not Mongoose-specific)
const mongoOptions = {
  serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
  socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
  maxPoolSize: 1, // Maintain up to 1 socket connection for serverless
  minPoolSize: 1, // Maintain at least 1 socket connection
  maxIdleTimeMS: 30000, // Close connections after 30s of inactivity
};

// Mongoose-specific options
const mongooseOptions = {
  bufferCommands: false, // Disable mongoose buffering (prevents timeout errors)
};

// Connect to MongoDB with retry logic
let isConnected = false;
let connectionPromise = null;

async function connectToMongoDB() {
  // Check if already connected
  if (mongoose.connection.readyState === 1) {
    isConnected = true;
    return;
  }

  // If connection is in progress, wait for it
  if (connectionPromise) {
    return connectionPromise;
  }

  // Start new connection
  connectionPromise = (async () => {
    try {
      // If already connecting, wait
      if (mongoose.connection.readyState === 2) {
        await new Promise((resolve) => {
          mongoose.connection.once('connected', resolve);
          mongoose.connection.once('error', resolve);
        });
        if (mongoose.connection.readyState === 1) {
          isConnected = true;
          connectionPromise = null;
          return;
        }
      }

      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/urlshortener', {
        ...mongooseOptions,
        ...mongoOptions
      });
      isConnected = true;
      console.log('Connected to MongoDB');
      
      mongoose.connection.on('error', (err) => {
        console.error('MongoDB connection error:', err);
        isConnected = false;
        connectionPromise = null;
      });
      
      mongoose.connection.on('disconnected', () => {
        console.log('MongoDB disconnected');
        isConnected = false;
        connectionPromise = null;
      });
      
      mongoose.connection.on('reconnected', () => {
        console.log('MongoDB reconnected');
        isConnected = true;
      });
      
      connectionPromise = null;
    } catch (error) {
      console.error('MongoDB connection error:', error);
      isConnected = false;
      connectionPromise = null;
      throw error;
    }
  })();

  return connectionPromise;
}

// Initialize connection
connectToMongoDB().catch(err => console.error('Failed to connect to MongoDB:', err));

// Click Event Schema for detailed tracking
const clickEventSchema = new mongoose.Schema({
  slug: { type: String, required: true, index: true },
  timestamp: { type: Date, default: Date.now },
  ip: String,
  userAgent: String,
  referer: String,
  // Parsed data
  browser: String,
  browserVersion: String,
  os: String,
  osVersion: String,
  device: String,
  deviceModel: String,
  // Location data
  country: String,
  region: String,
  city: String,
  // Client-side data
  screenWidth: Number,
  screenHeight: Number,
  language: String,
  timezone: String,
  // UTM parameters
  utmSource: String,
  utmMedium: String,
  utmCampaign: String,
  utmTerm: String,
  utmContent: String,
  // Time-based analytics
  hourOfDay: Number,
  dayOfWeek: Number,
  // Additional metadata
  isMobile: Boolean,
  isTablet: Boolean,
  isDesktop: Boolean
}, { timestamps: true });

const ClickEvent = mongoose.model('ClickEvent', clickEventSchema);

// URL Schema
const urlSchema = new mongoose.Schema({
  originalUrl: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null },
  clicks: { type: Number, default: 0 },
  analytics: {
    referrers: { type: Object, default: () => ({}) },
    browsers: { type: Object, default: () => ({}) },
    browserVersions: { type: Object, default: () => ({}) },
    devices: { type: Object, default: () => ({}) },
    deviceModels: { type: Object, default: () => ({}) },
    os: { type: Object, default: () => ({}) },
    osVersions: { type: Object, default: () => ({}) },
    countries: { type: Object, default: () => ({}) },
    regions: { type: Object, default: () => ({}) },
    cities: { type: Object, default: () => ({}) },
    languages: { type: Object, default: () => ({}) },
    timezones: { type: Object, default: () => ({}) },
    clicksByDate: { type: Object, default: () => ({}) },
    clicksByHour: { type: Object, default: () => ({}) },
    clicksByDayOfWeek: { type: Object, default: () => ({}) },
    screenResolutions: { type: Object, default: () => ({}) },
    utmSources: { type: Object, default: () => ({}) },
    utmMediums: { type: Object, default: () => ({}) },
    utmCampaigns: { type: Object, default: () => ({}) },
    deviceTypes: { type: Object, default: () => ({ mobile: 0, tablet: 0, desktop: 0 }) },
    platforms: { type: Object, default: () => ({}) },
    inAppBrowsers: { type: Object, default: () => ({}) },
    // Enhanced analytics
    connectionTypes: { type: Object, default: () => ({}) },
    botClicks: { type: Number, default: 0 },
    humanClicks: { type: Number, default: 0 },
    uniqueVisitors: { type: Object, default: () => ({}) }, // visitorId -> count
    darkModeUsers: { type: Number, default: 0 },
    lightModeUsers: { type: Number, default: 0 }
  }
});

const URL = mongoose.model('URL', urlSchema);

// File Schema - stores files as binary data in MongoDB
const fileSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true },
  originalName: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  type: { type: String, enum: ['image', 'file'], required: true },
  // Binary data storage in MongoDB
  data: { type: Buffer, required: true },
  // ETag for caching
  etag: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null },
  password: { type: String, default: null },
  maxDownloads: { type: Number, default: null },
  downloads: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  analytics: {
    downloadsByDate: { type: Object, default: () => ({}) },
    viewsByDate: { type: Object, default: () => ({}) },
    countries: { type: Object, default: () => ({}) },
    cities: { type: Object, default: () => ({}) },
    browsers: { type: Object, default: () => ({}) },
    operatingSystems: { type: Object, default: () => ({}) },
    devices: { type: Object, default: () => ({}) },
    referrers: { type: Object, default: () => ({}) },
    platforms: { type: Object, default: () => ({}) },
    languages: { type: Object, default: () => ({}) },
    screenResolutions: { type: Object, default: () => ({}) }
  }
});

// Helper function to track file analytics
async function trackFileAnalytics(slug, req, clientData = {}) {
  try {
    const file = await File.findOne({ slug });
    if (!file) return;

    const today = new Date().toISOString().split('T')[0];
    
    // Track views by date
    const viewsByDate = file.analytics.viewsByDate || {};
    viewsByDate[today] = (viewsByDate[today] || 0) + 1;
    file.analytics.viewsByDate = viewsByDate;

    // Track browser
    if (clientData.browser) {
      const browsers = file.analytics.browsers || {};
      browsers[clientData.browser] = (browsers[clientData.browser] || 0) + 1;
      file.analytics.browsers = browsers;
    }

    // Track OS
    if (clientData.os) {
      const operatingSystems = file.analytics.operatingSystems || {};
      operatingSystems[clientData.os] = (operatingSystems[clientData.os] || 0) + 1;
      file.analytics.operatingSystems = operatingSystems;
    }

    // Track device type
    if (clientData.deviceType) {
      const devices = file.analytics.devices || {};
      devices[clientData.deviceType] = (devices[clientData.deviceType] || 0) + 1;
      file.analytics.devices = devices;
    }

    // Track country
    if (clientData.country) {
      const countries = file.analytics.countries || {};
      countries[clientData.country] = (countries[clientData.country] || 0) + 1;
      file.analytics.countries = countries;
    }

    // Track city
    if (clientData.city) {
      const cities = file.analytics.cities || {};
      cities[clientData.city] = (cities[clientData.city] || 0) + 1;
      file.analytics.cities = cities;
    }

    // Track referrer
    if (clientData.referer) {
      const referrers = file.analytics.referrers || {};
      let refKey = clientData.referer;
      try {
        if (clientData.referer !== 'direct') {
          const refUrl = new URL(clientData.referer);
          refKey = refUrl.hostname;
        }
      } catch (e) {
        refKey = clientData.referer;
      }
      referrers[refKey] = (referrers[refKey] || 0) + 1;
      file.analytics.referrers = referrers;
    }

    // Track platform (social media, messaging, etc.)
    if (clientData.platform) {
      const platforms = file.analytics.platforms || {};
      platforms[clientData.platform] = (platforms[clientData.platform] || 0) + 1;
      file.analytics.platforms = platforms;
    }

    // Track language
    if (clientData.language) {
      const languages = file.analytics.languages || {};
      languages[clientData.language] = (languages[clientData.language] || 0) + 1;
      file.analytics.languages = languages;
    }

    // Track screen resolution
    if (clientData.screenResolution) {
      const screenResolutions = file.analytics.screenResolutions || {};
      screenResolutions[clientData.screenResolution] = (screenResolutions[clientData.screenResolution] || 0) + 1;
      file.analytics.screenResolutions = screenResolutions;
    }

    file.markModified('analytics');
    await file.save();
    
    console.log('File analytics tracked for:', slug);
  } catch (error) {
    console.error('Error tracking file analytics:', error);
  }
}

const File = mongoose.model('File', fileSchema);

// Multer configuration - use memory storage for DB uploads
const memoryStorage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  // Allow images and common file types
  const allowedTypes = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf', 'application/zip', 'application/x-zip-compressed',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv', 'application/json',
    'audio/mpeg', 'audio/wav', 'video/mp4', 'video/webm'
  ];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('File type not allowed'), false);
  }
};

// MongoDB document size limit is 16MB, so we limit uploads to 15MB for safety
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB max

const upload = multer({
  storage: memoryStorage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
  }
});

// Generate ETag from file content
function generateETag(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

// Helper function to determine if file is an image
function isImage(mimeType) {
  return mimeType.startsWith('image/');
}

// Middleware to ensure MongoDB connection
async function ensureMongoConnection(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) {
      await connectToMongoDB();
    }
    next();
  } catch (error) {
    console.error('MongoDB connection failed:', error);
    return res.status(503).json({ message: 'Database connection failed. Please try again.' });
  }
}

// Create a short URL
app.post('/api/shorten', ensureMongoConnection, async (req, res) => {
  try {
    const { url, slug, expiresIn } = req.body;

    // Validate inputs
    if (!url) {
      return res.status(400).json({ message: 'URL is required' });
    }

    // Add protocol if missing
    let formattedUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      formattedUrl = 'https://' + url;
    }
    let urlSlug = slug;
    
    // If no slug is provided, generate one
    if (!urlSlug) {
      urlSlug = nanoid(6); // Generate a 6-character random ID
    } else {
      // Validate slug format
      if (!/^[a-zA-Z0-9-_]+$/.test(urlSlug)) {
        return res.status(400).json({ 
          message: 'Custom path can only contain letters, numbers, hyphens and underscores' 
        });
      }
      
      // Check if slug already exists
      const existing = await URL.findOne({ slug: urlSlug });
      if (existing) {
        return res.status(409).json({ message: 'This custom path is already taken' });
      }
    }

    // Set expiration if provided
    let expiresAt = null;
    if (expiresIn) {
      const now = new Date();
      if (expiresIn === '1h') {
        expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
      } else if (expiresIn === '1d') {
        expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      } else if (expiresIn === '7d') {
        expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      } else if (expiresIn === '30d') {
        expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      }
    }

    // Create new URL record
    const newUrl = new URL({
      originalUrl: formattedUrl,
      slug: urlSlug,
      expiresAt
    });

    await newUrl.save();

    const baseUrl = process.env.BASE_URL || 'https://h4a.us';
    const shortUrl = `${baseUrl}/${urlSlug}`;

    return res.status(201).json({ 
      shortUrl, 
      slug: urlSlug,
      expiresAt: expiresAt ? expiresAt.toISOString() : null
    });
    
  } catch (error) {
    console.error('Error creating short URL:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Helper function to track analytics
async function trackAnalytics(slug, req, clientData = {}) {
  try {
    const url = await URL.findOne({ slug });
    if (!url) return;

    // Increment click count
    url.clicks += 1;
    
    // Get data from headers and client
    const userAgent = clientData.userAgent || req.headers['user-agent'] || '';
    const referer = clientData.referer || req.headers.referer || 'direct';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const acceptLanguage = clientData.language || req.headers['accept-language'] || '';
    
    // Use client-side detection first (more accurate), fallback to server-side UA parsing
    let browser = clientData.browser || 'Unknown';
    let browserVersion = clientData.browserVersion || 'Unknown';
    let os = clientData.os || 'Unknown';
    let osVersion = clientData.osVersion || 'Unknown';
    let device = clientData.deviceType || 'desktop';
    let deviceModel = 'Unknown';
    let isMobile = clientData.isMobile ?? false;
    let isTablet = clientData.isTablet ?? false;
    let isDesktop = clientData.isDesktop ?? true;
    
    // If client didn't provide device info, parse from user agent
    if (userAgent && browser === 'Unknown') {
      const parser = new UAParser(userAgent);
      const browserInfo = parser.getBrowser();
      const osInfo = parser.getOS();
      const deviceInfo = parser.getDevice();
      
      browser = browserInfo.name || 'Unknown';
      browserVersion = browserInfo.version || 'Unknown';
      os = osInfo.name || 'Unknown';
      osVersion = osInfo.version || 'Unknown';
      device = deviceInfo.type || 'desktop';
      deviceModel = deviceInfo.model || 'Unknown';
      
      isMobile = device === 'mobile';
      isTablet = device === 'tablet';
      isDesktop = !isMobile && !isTablet;
    }
    
    console.log('Tracking analytics:', { slug, browser, os, device, referer, ip: ip ? 'present' : 'none' });
    
    // Update browser stats
    const browsers = url.analytics.browsers || {};
    browsers[browser] = (browsers[browser] || 0) + 1;
    url.analytics.browsers = browsers;
    
    // Update browser version stats
    const browserVersions = url.analytics.browserVersions || {};
    const browserKey = `${browser} ${browserVersion}`;
    browserVersions[browserKey] = (browserVersions[browserKey] || 0) + 1;
    url.analytics.browserVersions = browserVersions;
    
    // Update OS stats
    const osStats = url.analytics.os || {};
    osStats[os] = (osStats[os] || 0) + 1;
    url.analytics.os = osStats;
    
    // Update OS version stats
    const osVersions = url.analytics.osVersions || {};
    const osKey = `${os} ${osVersion}`;
    osVersions[osKey] = (osVersions[osKey] || 0) + 1;
    url.analytics.osVersions = osVersions;
    
    // Update device stats
    const devices = url.analytics.devices || {};
    devices[device] = (devices[device] || 0) + 1;
    url.analytics.devices = devices;
    
    // Update device model stats
    if (deviceModel && deviceModel !== 'Unknown') {
      const deviceModels = url.analytics.deviceModels || {};
      deviceModels[deviceModel] = (deviceModels[deviceModel] || 0) + 1;
      url.analytics.deviceModels = deviceModels;
    }
    
    // Update device types
    const deviceTypes = url.analytics.deviceTypes || { mobile: 0, tablet: 0, desktop: 0 };
    if (isMobile) deviceTypes.mobile = (deviceTypes.mobile || 0) + 1;
    if (isTablet) deviceTypes.tablet = (deviceTypes.tablet || 0) + 1;
    if (isDesktop) deviceTypes.desktop = (deviceTypes.desktop || 0) + 1;
    url.analytics.deviceTypes = deviceTypes;
    
    // Update referrer stats
    const referrers = url.analytics.referrers || {};
    let referrerHost = 'direct';
    if (referer && referer !== 'direct') {
      try {
        referrerHost = new URL(referer).hostname;
      } catch (e) {
        console.log('Error parsing referrer URL:', e.message);
      }
    }
    referrers[referrerHost] = (referrers[referrerHost] || 0) + 1;
    url.analytics.referrers = referrers;
    
    // Get location data - prefer client-provided data, fallback to IP lookup
    let country = clientData.country || null;
    let region = clientData.regionName || clientData.region || null;
    let city = clientData.city || null;
    
    // If client didn't provide location, try IP lookup
    if (!country && ip && typeof ip === 'string') {
      const geo = geoip.lookup(ip.split(',')[0].trim());
      if (geo) {
        country = geo.country || null;
        region = geo.region || null;
        city = geo.city || null;
      }
    }
    
    console.log('Location data:', { country, region, city, source: clientData.country ? 'client' : 'ip-lookup' });
    
    // Update location stats
    if (country) {
      const countries = url.analytics.countries || {};
      countries[country] = (countries[country] || 0) + 1;
      url.analytics.countries = countries;
    }
    if (region) {
      const regions = url.analytics.regions || {};
      regions[region] = (regions[region] || 0) + 1;
      url.analytics.regions = regions;
    }
    if (city) {
      const cities = url.analytics.cities || {};
      cities[city] = (cities[city] || 0) + 1;
      url.analytics.cities = cities;
    }
    
    // Update language stats
    if (acceptLanguage) {
      const primaryLanguage = acceptLanguage.split(',')[0].split('-')[0].trim();
      const languages = url.analytics.languages || {};
      languages[primaryLanguage] = (languages[primaryLanguage] || 0) + 1;
      url.analytics.languages = languages;
    }
    
    // Update timezone (from client data)
    if (clientData.timezone) {
      const timezones = url.analytics.timezones || {};
      timezones[clientData.timezone] = (timezones[clientData.timezone] || 0) + 1;
      url.analytics.timezones = timezones;
    }
    
    // Update screen resolution (from client data)
    if (clientData.screenWidth && clientData.screenHeight) {
      const resolution = `${clientData.screenWidth}x${clientData.screenHeight}`;
      const screenResolutions = url.analytics.screenResolutions || {};
      screenResolutions[resolution] = (screenResolutions[resolution] || 0) + 1;
      url.analytics.screenResolutions = screenResolutions;
    }
    
    // Update platform/source (from client data)
    if (clientData.platform) {
      const platforms = url.analytics.platforms || {};
      platforms[clientData.platform] = (platforms[clientData.platform] || 0) + 1;
      url.analytics.platforms = platforms;
      console.log('Platform tracked:', clientData.platform);
    }
    
    // Update in-app browser tracking
    if (clientData.isInAppBrowser && clientData.appName) {
      const inAppBrowsers = url.analytics.inAppBrowsers || {};
      inAppBrowsers[clientData.appName] = (inAppBrowsers[clientData.appName] || 0) + 1;
      url.analytics.inAppBrowsers = inAppBrowsers;
      console.log('In-app browser tracked:', clientData.appName);
    }
    
    // Enhanced analytics: Connection type tracking
    if (clientData.connectionType) {
      const connectionTypes = url.analytics.connectionTypes || {};
      connectionTypes[clientData.connectionType] = (connectionTypes[clientData.connectionType] || 0) + 1;
      url.analytics.connectionTypes = connectionTypes;
    }
    
    // Enhanced analytics: Bot detection
    if (clientData.isBot !== undefined) {
      if (clientData.isBot) {
        url.analytics.botClicks = (url.analytics.botClicks || 0) + 1;
        console.log('Bot click detected');
      } else {
        url.analytics.humanClicks = (url.analytics.humanClicks || 0) + 1;
      }
    }
    
    // Enhanced analytics: Unique visitors
    if (clientData.visitorId) {
      const uniqueVisitors = url.analytics.uniqueVisitors || {};
      uniqueVisitors[clientData.visitorId] = (uniqueVisitors[clientData.visitorId] || 0) + 1;
      url.analytics.uniqueVisitors = uniqueVisitors;
    }
    
    // Enhanced analytics: Dark/Light mode preference
    if (clientData.prefersDarkMode !== undefined) {
      if (clientData.prefersDarkMode) {
        url.analytics.darkModeUsers = (url.analytics.darkModeUsers || 0) + 1;
      } else {
        url.analytics.lightModeUsers = (url.analytics.lightModeUsers || 0) + 1;
      }
    }
    
    // Update UTM parameters (from client data or query params)
    const utmSource = clientData.utmSource || req.query.utm_source;
    const utmMedium = clientData.utmMedium || req.query.utm_medium;
    const utmCampaign = clientData.utmCampaign || req.query.utm_campaign;
    const utmTerm = clientData.utmTerm || req.query.utm_term;
    const utmContent = clientData.utmContent || req.query.utm_content;
    
    if (utmSource) {
      const utmSources = url.analytics.utmSources || {};
      utmSources[utmSource] = (utmSources[utmSource] || 0) + 1;
      url.analytics.utmSources = utmSources;
    }
    if (utmMedium) {
      const utmMediums = url.analytics.utmMediums || {};
      utmMediums[utmMedium] = (utmMediums[utmMedium] || 0) + 1;
      url.analytics.utmMediums = utmMediums;
    }
    if (utmCampaign) {
      const utmCampaigns = url.analytics.utmCampaigns || {};
      utmCampaigns[utmCampaign] = (utmCampaigns[utmCampaign] || 0) + 1;
      url.analytics.utmCampaigns = utmCampaigns;
    }
    
    // Time-based analytics
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const hour = now.getHours();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
    
    const clicksByDate = url.analytics.clicksByDate || {};
    clicksByDate[today] = (clicksByDate[today] || 0) + 1;
    url.analytics.clicksByDate = clicksByDate;
    
    const clicksByHour = url.analytics.clicksByHour || {};
    clicksByHour[hour] = (clicksByHour[hour] || 0) + 1;
    url.analytics.clicksByHour = clicksByHour;
    
    const clicksByDayOfWeek = url.analytics.clicksByDayOfWeek || {};
    clicksByDayOfWeek[dayOfWeek] = (clicksByDayOfWeek[dayOfWeek] || 0) + 1;
    url.analytics.clicksByDayOfWeek = clicksByDayOfWeek;
    
    // Mark analytics as modified to ensure Mongoose saves nested object changes
    url.markModified('analytics');
    url.markModified('analytics.countries');
    url.markModified('analytics.regions');
    url.markModified('analytics.cities');
    url.markModified('analytics.timezones');
    url.markModified('analytics.browsers');
    url.markModified('analytics.os');
    url.markModified('analytics.devices');
    url.markModified('analytics.screenResolutions');
    url.markModified('analytics.languages');
    url.markModified('analytics.platforms');
    url.markModified('analytics.inAppBrowsers');
    url.markModified('analytics.connectionTypes');
    url.markModified('analytics.uniqueVisitors');
    
    await url.save();
    
    // Create detailed click event record
    const clickEvent = new ClickEvent({
      slug,
      timestamp: now,
      ip: clientData.clientIp || (ip && typeof ip === 'string') ? ip.split(',')[0].trim() : null,
      userAgent,
      referer,
      browser,
      browserVersion,
      os,
      osVersion,
      device,
      deviceModel,
      country: country || null,
      region: region || null,
      city: city || null,
      screenWidth: clientData.screenWidth || null,
      screenHeight: clientData.screenHeight || null,
      language: acceptLanguage ? acceptLanguage.split(',')[0].split('-')[0].trim() : null,
      timezone: clientData.timezone || null,
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      utmTerm: utmTerm || null,
      utmContent: utmContent || null,
      hourOfDay: hour,
      dayOfWeek: dayOfWeek,
      isMobile,
      isTablet,
      isDesktop
    });
    
    await clickEvent.save();
    
  } catch (error) {
    console.error('Error tracking analytics:', error);
  }
}

// Get URL by slug (no tracking here - tracking is done via POST /api/analytics/:slug)
app.get('/api/url/:slug', ensureMongoConnection, async (req, res) => {
  try {
    const { slug } = req.params;
    
    const url = await URL.findOne({ slug });
    
    if (!url) {
      return res.status(404).json({ message: 'URL not found' });
    }

    // Check if URL has expired
    if (url.expiresAt && new Date() > url.expiresAt) {
      return res.status(410).json({ message: 'This link has expired' });
    }
    
    // Don't track analytics here - it's done via POST /api/analytics/:slug
    // This prevents double counting (server fetch + client POST)
    
    return res.json({ originalUrl: url.originalUrl });
    
  } catch (error) {
    console.error('Error redirecting:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Track comprehensive analytics from client-side
app.post('/api/analytics/:slug', ensureMongoConnection, async (req, res) => {
  try {
    const { slug } = req.params;
    const clientData = req.body;
    
    const url = await URL.findOne({ slug });
    
    if (!url) {
      return res.status(404).json({ message: 'URL not found' });
    }

    // Check if URL has expired
    if (url.expiresAt && new Date() > url.expiresAt) {
      return res.status(410).json({ message: 'This link has expired' });
    }
    
    // Track comprehensive analytics with client data
    await trackAnalytics(slug, req, clientData);
    
    return res.json({ success: true, message: 'Analytics tracked' });
    
  } catch (error) {
    console.error('Error tracking analytics:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get analytics for a URL
app.get('/api/analytics/:slug', ensureMongoConnection, async (req, res) => {
  try {
    const { slug } = req.params;
    const { includeEvents, limit = 100 } = req.query;
    
    const url = await URL.findOne({ slug });
    
    if (!url) {
      return res.status(404).json({ message: 'URL not found' });
    }
    
    // Get all comprehensive analytics
    const analytics = {
      referrers: url.analytics.referrers || {},
      browsers: url.analytics.browsers || {},
      browserVersions: url.analytics.browserVersions || {},
      devices: url.analytics.devices || {},
      deviceModels: url.analytics.deviceModels || {},
      os: url.analytics.os || {},
      osVersions: url.analytics.osVersions || {},
      countries: url.analytics.countries || {},
      regions: url.analytics.regions || {},
      cities: url.analytics.cities || {},
      languages: url.analytics.languages || {},
      timezones: url.analytics.timezones || {},
      clicksByDate: url.analytics.clicksByDate || {},
      clicksByHour: url.analytics.clicksByHour || {},
      clicksByDayOfWeek: url.analytics.clicksByDayOfWeek || {},
      screenResolutions: url.analytics.screenResolutions || {},
      utmSources: url.analytics.utmSources || {},
      utmMediums: url.analytics.utmMediums || {},
      utmCampaigns: url.analytics.utmCampaigns || {},
      deviceTypes: url.analytics.deviceTypes || { mobile: 0, tablet: 0, desktop: 0 },
      platforms: url.analytics.platforms || {},
      inAppBrowsers: url.analytics.inAppBrowsers || {},
      // Enhanced analytics
      connectionTypes: url.analytics.connectionTypes || {},
      botClicks: url.analytics.botClicks || 0,
      humanClicks: url.analytics.humanClicks || 0,
      uniqueVisitors: url.analytics.uniqueVisitors || {},
      darkModeUsers: url.analytics.darkModeUsers || 0,
      lightModeUsers: url.analytics.lightModeUsers || 0
    };
    
    const response = {
      slug: url.slug,
      originalUrl: url.originalUrl,
      shortUrl: `${process.env.BASE_URL || 'https://h4a.us'}/${url.slug}`,
      createdAt: url.createdAt,
      expiresAt: url.expiresAt,
      clicks: url.clicks,
      analytics
    };
    
    // Optionally include individual click events
    if (includeEvents === 'true') {
      const events = await ClickEvent.find({ slug })
        .sort({ timestamp: -1 })
        .limit(parseInt(limit))
        .lean();
      response.events = events;
      response.totalEvents = await ClickEvent.countDocuments({ slug });
    }
    
    return res.json(response);
    
  } catch (error) {
    console.error('Error getting analytics:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get click events for a URL
app.get('/api/analytics/:slug/events', async (req, res) => {
  try {
    const { slug } = req.params;
    const { page = 1, limit = 50, startDate, endDate } = req.query;
    
    const url = await URL.findOne({ slug });
    
    if (!url) {
      return res.status(404).json({ message: 'URL not found' });
    }
    
    const query = { slug };
    
    // Add date range filter if provided
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) query.timestamp.$lte = new Date(endDate);
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const events = await ClickEvent.find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const totalEvents = await ClickEvent.countDocuments(query);
    
    return res.json({
      events,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalEvents,
        pages: Math.ceil(totalEvents / parseInt(limit))
      }
    });
    
  } catch (error) {
    console.error('Error getting click events:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete a URL
app.delete('/api/url/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const result = await URL.deleteOne({ slug });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'URL not found' });
    }
    
    return res.json({ message: 'URL deleted successfully' });
    
  } catch (error) {
    console.error('Error deleting URL:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Clean up expired URLs (can be run with a cron job)
app.post('/api/cleanup', async (req, res) => {
  try {
    const now = new Date();
    const result = await URL.deleteMany({ expiresAt: { $lt: now } });
    
    return res.json({ 
      message: `Deleted ${result.deletedCount} expired URLs` 
    });
    
  } catch (error) {
    console.error('Error cleaning up expired URLs:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get all URLs (admin endpoint)
app.get('/api/urls', ensureMongoConnection, async (req, res) => {
  try {
    const urls = await URL.find({}, { 
      slug: 1, 
      originalUrl: 1, 
      createdAt: 1, 
      expiresAt: 1, 
      clicks: 1 
    });
    
    return res.json(urls);
    
  } catch (error) {
    console.error('Error getting all URLs:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ==================== FILE UPLOAD ENDPOINTS ====================

// Upload a file - stores in MongoDB for fast access
app.post('/api/upload', ensureMongoConnection, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const { customSlug, password, expiresIn, maxDownloads } = req.body;
    
    // Generate or use custom slug
    let slug = customSlug && customSlug.trim() ? customSlug.trim() : nanoid(8);
    
    // Check if slug already exists
    const existingFile = await File.findOne({ slug });
    const existingUrl = await URL.findOne({ slug });
    if (existingFile || existingUrl) {
      return res.status(400).json({ message: 'This custom path is already taken' });
    }

    // Calculate expiration
    let expiresAt = null;
    if (expiresIn) {
      const hours = parseInt(expiresIn);
      if (!isNaN(hours) && hours > 0) {
        expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
      }
    }

    // Determine file type
    const fileType = isImage(req.file.mimetype) ? 'image' : 'file';
    
    // Generate ETag for caching
    const etag = generateETag(req.file.buffer);

    // Store file data in MongoDB
    const newFile = new File({
      slug,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      type: fileType,
      data: req.file.buffer, // Store binary data directly in MongoDB
      etag,
      expiresAt,
      password: password || null,
      maxDownloads: maxDownloads ? parseInt(maxDownloads) : null
    });

    await newFile.save();
    console.log(`File uploaded to DB: ${slug} (${(req.file.size / 1024).toFixed(1)} KB)`);

    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const prefix = fileType === 'image' ? 'i' : 'f';

    return res.status(201).json({
      slug,
      shortUrl: `${baseUrl}/${prefix}/${slug}`,
      originalName: req.file.originalname,
      size: req.file.size,
      type: fileType,
      expiresAt
    });

  } catch (error) {
    console.error('Error uploading file:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get file info
app.get('/api/file/:slug', ensureMongoConnection, async (req, res) => {
  try {
    const { slug } = req.params;
    
    const file = await File.findOne({ slug });
    
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    // Check if file has expired
    if (file.expiresAt && new Date() > file.expiresAt) {
      return res.status(410).json({ message: 'This file has expired' });
    }

    // Increment view count
    file.views += 1;
    await file.save();

    return res.json({
      slug: file.slug,
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      type: file.type,
      createdAt: file.createdAt,
      expiresAt: file.expiresAt,
      downloads: file.downloads,
      views: file.views,
      hasPassword: !!file.password,
      maxDownloads: file.maxDownloads
    });

  } catch (error) {
    console.error('Error getting file info:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Track file analytics from client-side
app.post('/api/file/:slug/analytics', async (req, res) => {
  try {
    const { slug } = req.params;
    const clientData = req.body;
    
    console.log('File analytics received for:', slug);
    
    await trackFileAnalytics(slug, req, clientData);
    
    return res.json({ success: true, message: 'File analytics tracked' });
    
  } catch (error) {
    console.error('Error tracking file analytics:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get file analytics data
app.get('/api/file/:slug/stats', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const file = await File.findOne({ slug });
    
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const shortUrl = `${baseUrl}/${file.type === 'image' ? 'i' : 'f'}/${file.slug}`;

    return res.json({
      slug: file.slug,
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      type: file.type,
      shortUrl,
      createdAt: file.createdAt,
      expiresAt: file.expiresAt,
      downloads: file.downloads,
      views: file.views,
      analytics: file.analytics
    });

  } catch (error) {
    console.error('Error getting file analytics:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Download/view file - serves from MongoDB with caching
app.get('/api/file/:slug/download', ensureMongoConnection, async (req, res) => {
  try {
    const { slug } = req.params;
    const { password } = req.query;
    
    const file = await File.findOne({ slug });
    
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    // Check if file has expired
    if (file.expiresAt && new Date() > file.expiresAt) {
      return res.status(410).json({ message: 'This file has expired' });
    }

    // Check password
    if (file.password && file.password !== password) {
      return res.status(401).json({ message: 'Invalid password' });
    }

    // Check if file data exists
    if (!file.data) {
      return res.status(404).json({ message: 'File data not found' });
    }

    // Check ETag for cache validation (304 Not Modified)
    const clientETag = req.headers['if-none-match'];
    if (file.etag && clientETag === `"${file.etag}"`) {
      return res.status(304).end();
    }

    // Set caching headers for fast loading
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName)}"`);
    
    // Cache for 1 year (immutable content)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Last-Modified', file.createdAt.toUTCString());
    
    if (file.etag) {
      res.setHeader('ETag', `"${file.etag}"`);
    }

    // Increment download count (don't await to speed up response)
    File.updateOne(
      { slug },
      { 
        $inc: { downloads: 1 },
        $set: { [`analytics.downloadsByDate.${new Date().toISOString().split('T')[0]}`]: (file.analytics?.downloadsByDate?.[new Date().toISOString().split('T')[0]] || 0) + 1 }
      }
    ).catch(err => console.error('Error updating download count:', err));

    // Serve file from MongoDB
    return res.send(file.data);

  } catch (error) {
    console.error('Error downloading file:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get all files (for admin/dashboard)
app.get('/api/files', ensureMongoConnection, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    let query = {};
    if (search) {
      query = {
        $or: [
          { slug: { $regex: search, $options: 'i' } },
          { originalName: { $regex: search, $options: 'i' } }
        ]
      };
    }
    
    const files = await File.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('-analytics -data') // Exclude binary data and analytics for faster listing
      .lean();
    
    const total = await File.countDocuments(query);
    
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const filesWithUrls = files.map(file => ({
      ...file,
      shortUrl: `${baseUrl}/${file.type === 'image' ? 'i' : 'f'}/${file.slug}`,
      isExpired: file.expiresAt ? new Date() > new Date(file.expiresAt) : false
    }));
    
    return res.json({
      files: filesWithUrls,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Error getting files:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete a file
app.delete('/api/file/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const file = await File.findOne({ slug });
    
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    // Delete from database (removes binary data)
    await File.deleteOne({ slug });

    return res.json({ message: 'File deleted successfully' });

  } catch (error) {
    console.error('Error deleting file:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    return res.json({ 
      status: 'ok',
      mongodb: mongoStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(503).json({ 
      status: 'error',
      mongodb: 'error',
      error: error.message 
    });
  }
});

// Start the server (only in non-serverless environment)
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

// Export for Vercel serverless
export default app;
