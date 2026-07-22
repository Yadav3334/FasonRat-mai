import crypto from 'crypto';

/**
 * Generates RFC 5389 time-limited HMAC credentials for TURN server authentication.
 * @param deviceId The ID of the device connecting to the TURN server.
 * @param secret The shared secret configured in the Coturn server.
 * @param ttlSeconds Time-to-live for the credentials in seconds (default: 86400 = 24 hours).
 * @returns Object containing the generated username and password.
 */
export function generateTurnCredentials(deviceId: string, secret: string, ttlSeconds: number = 86400) {
    const expireUnixTimestamp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const username = `${expireUnixTimestamp}:${deviceId}`;
    
    const hmac = crypto.createHmac('sha1', secret);
    hmac.update(username);
    const password = hmac.digest('base64');
    
    return {
        username,
        password,
        ttl: ttlSeconds
    };
}
