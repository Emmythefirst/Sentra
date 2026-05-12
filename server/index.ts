import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import portfolioRoutes from './routes/portfolio.js';
import agentRoutes from './routes/agent.js';
import { startScheduler } from './cron/scheduler.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.CLIENT_URL,
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) {
      return callback(null, true);
    }
    // Allow any vercel.app subdomain
    if (origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());

app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'Sentra backend running', timestamp: new Date().toISOString() });
});

app.use('/api/portfolio', portfolioRoutes);
app.use('/api/agent', agentRoutes);

app.listen(PORT, () => {
  console.log(`\n🚀 Sentra backend running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Zerion test: http://localhost:${PORT}/api/portfolio/test`);
  startScheduler();
});