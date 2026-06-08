// @author William Ragnarsson
// @date 2025-12-01

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key-change-in-production';
const JWT_EXPIRATION = '30m'; // Token expiration time (e.g., '30m', '1h', '7d')
const JWT_REFRESH_THRESHOLD = 300; // Refresh token if less than this many seconds remain (5 minutes)

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    username: string;
  };
  newToken?: string;
}

/**
 * Middleware to authenticate JWT token and refresh if needed
 */
export function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const authValue = typeof authHeader === 'string' ? authHeader : authHeader?.[0];
  const token = authValue?.startsWith('Bearer ') ? authValue.substring(7) : null;

  if (!token) {
    res.status(401).json({ success: false, message: 'No token provided' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      username: string;
      iat?: number;
      exp?: number;
    };

    // Store user info in request
    req.user = {
      userId: decoded.userId,
      username: decoded.username,
    };

    // Check if token is about to expire (5 minutes or less)
    if (decoded.exp) {
      const currentTime = Math.floor(Date.now() / 1000);
      const timeUntilExpiry = decoded.exp - currentTime;

      // If less than threshold remaining, issue new token
      if (timeUntilExpiry <= JWT_REFRESH_THRESHOLD) {
        req.newToken = jwt.sign({ userId: decoded.userId, username: decoded.username }, JWT_SECRET, {
          expiresIn: JWT_EXPIRATION,
        });
      }
    }

    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
    return;
  }
}

/**
 * Helper function to add token to response if it was refreshed
 */
export function addTokenToResponse<T extends Record<string, unknown>>(
  req: AuthenticatedRequest,
  responseData: T,
): T & { token?: string } {
  if (req.newToken) {
    return { ...responseData, token: req.newToken };
  }
  return responseData as T & { token?: string };
}

/**
 * Generate a new JWT token
 */
export function generateToken(userId: string, username: string): string {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: JWT_EXPIRATION });
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): { userId: string; username: string; exp?: number } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { userId: string; username: string; exp?: number };
  } catch {
    return null;
  }
}

/**
 * Validate existing token and refresh if needed (for auto-login)
 * @returns Object with success status and optional new token
 */
export function validateAndRefreshToken(token: string): {
  valid: boolean;
  userId?: string;
  username?: string;
  newToken?: string;
} {
  const decoded = verifyToken(token);

  if (!decoded) {
    return { valid: false };
  }

  const result: { valid: boolean; userId?: string; username?: string; newToken?: string } = {
    valid: true,
    userId: decoded.userId,
    username: decoded.username,
  };

  // Check if token is about to expire
  if (decoded.exp) {
    const currentTime = Math.floor(Date.now() / 1000);
    const timeUntilExpiry = decoded.exp - currentTime;

    // If less than threshold remaining, issue new token
    if (timeUntilExpiry <= JWT_REFRESH_THRESHOLD) {
      result.newToken = generateToken(decoded.userId, decoded.username);
    }
  }

  return result;
}
