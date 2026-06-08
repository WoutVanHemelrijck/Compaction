// @author William Ragnarsson
// @date 2025-12-03

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response, NextFunction } from 'express';
import {
  authenticateToken,
  addTokenToResponse,
  generateToken,
  verifyToken,
  validateAndRefreshToken,
  type AuthenticatedRequest,
} from '../auth/authentication.mjs';

describe('Authentication Module', () => {
  describe('generateToken', () => {
    it('should generate a valid JWT token', () => {
      const token = generateToken('user123', 'testuser');

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });

    it('should generate different tokens for different users', () => {
      const token1 = generateToken('user1', 'alice');
      const token2 = generateToken('user2', 'bob');

      expect(token1).not.toBe(token2);
    });
  });

  describe('verifyToken', () => {
    it('should verify and decode a valid token', () => {
      const token = generateToken('user123', 'testuser');
      const decoded = verifyToken(token);

      expect(decoded).not.toBeNull();
      expect(decoded?.userId).toBe('user123');
      expect(decoded?.username).toBe('testuser');
      expect(decoded?.exp).toBeDefined();
    });

    it('should return null for invalid token', () => {
      const decoded = verifyToken('invalid-token-string');

      expect(decoded).toBeNull();
    });

    it('should return null for malformed token', () => {
      const decoded = verifyToken('not.a.valid.jwt');

      expect(decoded).toBeNull();
    });

    it('should return null for expired token', () => {
      // Create a token that expires immediately
      const expiredToken =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c2VyMTIzIiwidXNlcm5hbWUiOiJ0ZXN0dXNlciIsImlhdCI6MTYwOTQ1OTIwMCwiZXhwIjoxNjA5NDU5MjAwfQ.invalid';

      const decoded = verifyToken(expiredToken);

      expect(decoded).toBeNull();
    });
  });

  describe('addTokenToResponse', () => {
    it('should add token to response if newToken exists', () => {
      const req = { newToken: 'refreshed-token-xyz' } as AuthenticatedRequest;
      const responseData = { success: true, message: 'Test' };

      const result = addTokenToResponse(req, responseData);

      expect(result).toEqual({
        success: true,
        message: 'Test',
        token: 'refreshed-token-xyz',
      });
    });

    it('should not modify response if no newToken', () => {
      const req = {} as AuthenticatedRequest;
      const responseData = { success: true, message: 'Test' };

      const result = addTokenToResponse(req, responseData);

      expect(result).toEqual({ success: true, message: 'Test' });
      expect(result).not.toHaveProperty('token');
    });

    it('should preserve all original response properties', () => {
      const req = { newToken: 'token123' } as AuthenticatedRequest;
      const responseData = { success: true, data: { id: 1, name: 'Test' }, count: 5 };

      const result = addTokenToResponse(req, responseData);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: 1, name: 'Test' });
      expect(result.count).toBe(5);
      expect(result.token).toBe('token123');
    });
  });

  describe('authenticateToken middleware', () => {
    let mockReq: Partial<AuthenticatedRequest>;
    let mockRes: Partial<Response>;
    let mockNext: NextFunction;

    beforeEach(() => {
      mockReq = {
        headers: {},
      };
      mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      };
      mockNext = vi.fn();
    });

    it('should reject request with no token', () => {
      authenticateToken(mockReq as AuthenticatedRequest, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        message: 'No token provided',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject request with invalid token', () => {
      mockReq.headers = { authorization: 'Bearer invalid-token' };

      authenticateToken(mockReq as AuthenticatedRequest, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        message: 'Invalid or expired token',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should accept request with valid token', () => {
      const token = generateToken('user123', 'testuser');
      mockReq.headers = { authorization: `Bearer ${token}` };

      authenticateToken(mockReq as AuthenticatedRequest, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.user).toBeDefined();
      expect(mockReq.user?.userId).toBe('user123');
      expect(mockReq.user?.username).toBe('testuser');
    });

    it('should handle authorization header', () => {
      const token = generateToken('user123', 'testuser');
      mockReq.headers = { authorization: `Bearer ${token}` };

      authenticateToken(mockReq as AuthenticatedRequest, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.user?.userId).toBe('user123');
    });

    it('should reject token without Bearer prefix', () => {
      const token = generateToken('user123', 'testuser');
      mockReq.headers = { authorization: token };

      authenticateToken(mockReq as AuthenticatedRequest, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should not set newToken if token is not expiring soon', () => {
      const token = generateToken('user123', 'testuser');
      mockReq.headers = { authorization: `Bearer ${token}` };

      authenticateToken(mockReq as AuthenticatedRequest, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.newToken).toBeUndefined();
    });

    // Note: Testing token refresh (when exp < 5 minutes) would require mocking time
    // or creating a token with a specific expiration time, which is complex with the current setup
  });

  describe('validateAndRefreshToken', () => {
    it('should return valid=true for a valid token', () => {
      const token = generateToken('user123', 'testuser');
      const result = validateAndRefreshToken(token);

      expect(result.valid).toBe(true);
      expect(result.userId).toBe('user123');
      expect(result.username).toBe('testuser');
    });

    it('should return valid=false for an invalid token', () => {
      const result = validateAndRefreshToken('invalid-token');

      expect(result.valid).toBe(false);
      expect(result.userId).toBeUndefined();
      expect(result.username).toBeUndefined();
      expect(result.newToken).toBeUndefined();
    });

    it('should return valid=false for a malformed token', () => {
      const result = validateAndRefreshToken('not.a.valid.jwt');

      expect(result.valid).toBe(false);
    });

    it('should return valid=false for an expired token', () => {
      const expiredToken =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c2VyMTIzIiwidXNlcm5hbWUiOiJ0ZXN0dXNlciIsImlhdCI6MTYwOTQ1OTIwMCwiZXhwIjoxNjA5NDU5MjAwfQ.invalid';

      const result = validateAndRefreshToken(expiredToken);

      expect(result.valid).toBe(false);
    });

    it('should include user data when token is valid', () => {
      const token = generateToken('alice123', 'alice');
      const result = validateAndRefreshToken(token);

      expect(result.valid).toBe(true);
      expect(result.userId).toBe('alice123');
      expect(result.username).toBe('alice');
    });

    it('should not include newToken for freshly generated token', () => {
      const token = generateToken('user123', 'testuser');
      const result = validateAndRefreshToken(token);

      expect(result.valid).toBe(true);
      expect(result.newToken).toBeUndefined();
    });

    it('should preserve all required fields in response', () => {
      const token = generateToken('bob456', 'bob');
      const result = validateAndRefreshToken(token);

      expect(result).toHaveProperty('valid');
      expect(result.valid).toBe(true);
      expect(result).toHaveProperty('userId');
      expect(result).toHaveProperty('username');
    });
  });
});
