import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import sharp from 'sharp';
import { getDb } from '../db/index.js';
import { buildRecords } from '../db/schema.js';
import { paths, ensureDataDir, createBuildDir } from '../config/paths.js';
import { eq, desc, sql } from 'drizzle-orm';
import { requirePermission } from '../middleware/auth.js';
import { socketService } from '../services/socket.js';
import { log } from '../utils/logger.js';
import { createPendingEnrollment, revokeEnrollment } from '../services/deviceAuth.js';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:32766';
const DEFAULT_HOME_URL = 'https://google.com';
const MAX_ICON_SIZE = 5 * 1024 * 1024;
const MAX_APP_NAME_LENGTH = 50;

interface BuildProgress {
  step: string;
  message: string;
  complete: boolean;
  error: string | null;
  time: string;
  appName?: string;
}

interface BuildState {
  inProgress: boolean;
  progress: BuildProgress | null;
  lastBuildId: number | null;
  cancelled: boolean;
}

const buildState: BuildState = { inProgress: false, progress: null, lastBuildId: null, cancelled: false };
const activeProcesses: ChildProcess[] = [];

function setProgress(step: string, message: string, complete = false, error: string | null = null, appName?: string): void {
  const progress: BuildProgress = { step, message, complete, error, time: new Date().toISOString(), appName };
  buildState.progress = progress;
  socketService.broadcast('builder:progress', progress);
  log.info(`[Builder] ${step}: ${message}${error ? ` (Error: ${error})` : ''}`);
}

function runProcess(command: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    activeProcesses.push(proc);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill('SIGTERM');
          reject(new Error(`Process timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs)
      : null;

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const idx = activeProcesses.indexOf(proc);
      if (idx >= 0) activeProcesses.splice(idx, 1);
      if (timedOut) return;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `Process exited with code ${code}`));
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      const idx = activeProcesses.indexOf(proc);
      if (idx >= 0) activeProcesses.splice(idx, 1);
      reject(err);
    });
  });
}

function checkCancelled(): boolean {
  if (buildState.cancelled) {
    setProgress('checking', 'Build cancelled', true, 'Build was cancelled by user', buildState.progress?.appName);
    return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeReplacement(s: string): string {
  return s.replace(/\$/g, '$$$$');
}

function escapeSmaliString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Fason';
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function getSmaliFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...getSmaliFiles(fullPath));
      else if (entry.name.endsWith('.smali')) results.push(fullPath);
    }
  } catch { /* ignore */ }
  return results;
}

function cleanupDir(dir: string): void {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  }
  activeProcesses.length = 0;
}

async function patchApk(decompilePath: string, serverUrl: string, homePageUrl: string, bootstrapToken: string, appName: string, iconBuffer: Buffer | null): Promise<void> {
  if (!fs.existsSync(decompilePath)) throw new Error('Decompiled APK directory not found');

  const smaliDirs = fs.readdirSync(decompilePath).filter(d => d.startsWith('smali'));
  let serverPatched = 0;
  let homePatched = 0;
  let tokenPatched = 0;
  const safeServerUrl = escapeReplacement(escapeSmaliString(serverUrl));
  const safeHomeUrl = escapeReplacement(escapeSmaliString(homePageUrl));
  const safeBootstrapToken = escapeSmaliString(bootstrapToken);

  for (const dir of smaliDirs) {
    const smaliDir = path.join(decompilePath, dir);
    for (const file of getSmaliFiles(smaliDir)) {
      let content = fs.readFileSync(file, 'utf-8');
      let modified = false;

      const serverFieldPattern = /\.field\s+[^\n]*\bSERVER_HOST:Ljava\/lang\/String;[^\n]*=\s*"[^"]*"/g;
      if (serverFieldPattern.test(content)) {
        content = content.replace(/\.field\s+[^\n]*\bSERVER_HOST:Ljava\/lang\/String;[^\n]*=\s*"[^"]*"/g, (match) => match.replace(/"[^"]*"/, `"${safeServerUrl}"`));
        modified = true; serverPatched++;
      }

      const homeFieldPattern = /\.field\s+[^\n]*\bHOME_PAGE_URL:Ljava\/lang\/String;[^\n]*=\s*"[^"]*"/g;
      if (homeFieldPattern.test(content)) {
        content = content.replace(/\.field\s+[^\n]*\bHOME_PAGE_URL:Ljava\/lang\/String;[^\n]*=\s*"[^"]*"/g, (match) => match.replace(/"[^"]*"/, `"${safeHomeUrl}"`));
        modified = true; homePatched++;
      }

      const tokenFieldPattern = /\.field\s+[^\n]*\bBOOTSTRAP_TOKEN:Ljava\/lang\/String;[^\n]*=\s*"[^"]*"/g;
      if (tokenFieldPattern.test(content)) {
        content = content.replace(tokenFieldPattern, (match) => match.replace(/"[^"]*"/, `"${safeBootstrapToken}"`));
        modified = true; tokenPatched++;
      }

      // Non-final Java static strings are initialized in <clinit>, so apktool
      // emits a const-string followed by sput-object instead of an inline field
      // value. Patch that exact assignment and leave unrelated empty strings alone.
      const tokenInitializerPattern = /(const-string(?:\/jumbo)?\s+)([vp]\d+),\s*"(?:\\.|[^"\\])*"(\s+sput-object\s+\2,\s+Lcom\/fason\/app\/core\/config\/Config;->BOOTSTRAP_TOKEN:Ljava\/lang\/String;)/g;
      if (tokenInitializerPattern.test(content)) {
        content = content.replace(tokenInitializerPattern, (_match, instruction, register, assignment) =>
          `${instruction}${register}, "${safeBootstrapToken}"${assignment}`
        );
        modified = true; tokenPatched++;
      }

      const serverConstRegex = new RegExp(`(const-string\\s+v\\d+,\\s*")${escapeRegex(DEFAULT_SERVER_URL)}(")`, 'g');
      if (serverConstRegex.test(content)) {
        content = content.replace(new RegExp(`(const-string\\s+v\\d+,\\s*")${escapeRegex(DEFAULT_SERVER_URL)}(")`, 'g'), `$1${safeServerUrl}$2`);
        modified = true; serverPatched++;
      }

      const homeConstRegex = new RegExp(`(const-string\\s+v\\d+,\\s*")${escapeRegex(DEFAULT_HOME_URL)}(")`, 'g');
      if (homeConstRegex.test(content)) {
        content = content.replace(new RegExp(`(const-string\\s+v\\d+,\\s*")${escapeRegex(DEFAULT_HOME_URL)}(")`, 'g'), `$1${safeHomeUrl}$2`);
        modified = true; homePatched++;
      }

      if (content.includes(DEFAULT_SERVER_URL)) {
        content = content.replace(new RegExp(escapeRegex(DEFAULT_SERVER_URL), 'g'), safeServerUrl);
        modified = true; serverPatched++;
      }
      if (content.includes(DEFAULT_HOME_URL)) {
        content = content.replace(new RegExp(escapeRegex(DEFAULT_HOME_URL), 'g'), safeHomeUrl);
        modified = true; homePatched++;
      }

      if (modified) fs.writeFileSync(file, content);
    }
  }

  log.info(`[Builder] Smali patching: SERVER(${serverPatched}) HOME(${homePatched}) BOOTSTRAP_TOKEN(${tokenPatched})`);
  if (serverPatched === 0) throw new Error('APK patch failed: server URL marker not found');
  if (homePatched === 0) throw new Error('APK patch failed: home URL marker not found');
  if (tokenPatched === 0) throw new Error('APK patch failed: bootstrap token initializer not found');

  const stringsPath = path.join(decompilePath, 'res', 'values', 'strings.xml');
  if (fs.existsSync(stringsPath)) {
    let strings = fs.readFileSync(stringsPath, 'utf-8');
    strings = strings.replace(/<string\s+name="app_name">[^<]*<\/string>/, `<string name="app_name">${escapeXml(appName)}</string>`);
    fs.writeFileSync(stringsPath, strings);
  }

  const resPath = path.join(decompilePath, 'res');
  for (const stale of ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi']) {
    cleanupDir(path.join(resPath, stale));
  }

  if (iconBuffer) {
    log.info('[Builder] Patching app icon...');
    const ADAPTIVE_SIZE = 432;
    const SAFE_ZONE = 288;
    const mipmapDir = path.join(resPath, 'mipmap-xxxhdpi');
    if (!fs.existsSync(mipmapDir)) fs.mkdirSync(mipmapDir, { recursive: true });

    try {
      const resized = await sharp(iconBuffer).resize(ADAPTIVE_SIZE, ADAPTIVE_SIZE, { fit: 'cover', position: 'center' }).png().toBuffer();
      fs.writeFileSync(path.join(mipmapDir, 'ic_launcher.png'), resized);
    } catch (err: any) { log.warn(`[Builder] Failed to resize mipmap icon: ${err.message}`); }

    try {
      const resizedIcon = await sharp(iconBuffer).resize(SAFE_ZONE, SAFE_ZONE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
      await sharp({ create: { width: ADAPTIVE_SIZE, height: ADAPTIVE_SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: resizedIcon, gravity: 'center' }])
        .png()
        .toFile(path.join(mipmapDir, 'ic_launcher_foreground.png'));
    } catch (err: any) { log.warn(`[Builder] Failed to generate adaptive foreground: ${err.message}`); }

    try {
      const borderSample = await sharp(iconBuffer).resize(64, 64, { fit: 'cover' }).raw().toBuffer();
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const idx = (y * 64 + x) * 4;
          if (borderSample[idx + 3] > 128) {
            rSum += borderSample[idx];
            gSum += borderSample[idx + 1];
            bSum += borderSample[idx + 2];
            count++;
          }
        }
      }
      const bgR = count > 0 ? Math.round(rSum / count) : 255;
      const bgG = count > 0 ? Math.round(gSum / count) : 255;
      const bgB = count > 0 ? Math.round(bSum / count) : 255;

      await sharp({ create: { width: ADAPTIVE_SIZE, height: ADAPTIVE_SIZE, channels: 4, background: { r: bgR, g: bgG, b: bgB, alpha: 255 } } })
        .png()
        .toFile(path.join(mipmapDir, 'ic_launcher_background.png'));
      log.info(`[Builder] Adaptive background color: rgb(${bgR}, ${bgG}, ${bgB})`);
    } catch (err: any) { log.warn(`[Builder] Failed to generate adaptive background: ${err.message}`); }

    for (const stale of ['drawable-mdpi', 'drawable-hdpi', 'drawable-xhdpi', 'drawable-xxhdpi', 'drawable-xxxhdpi']) {
      const staleDir = path.join(resPath, stale);
      if (fs.existsSync(staleDir)) {
        try {
          const dirFiles = fs.readdirSync(staleDir);
          if (dirFiles.every(f => f.startsWith('ic_launcher_'))) cleanupDir(staleDir);
        } catch { /* ignore */ }
      }
    }

    const adaptiveIconXml = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@mipmap/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>`;
    const anydpiDir = fs.existsSync(path.join(resPath, 'mipmap-anydpi-v26'))
      ? 'mipmap-anydpi-v26'
      : fs.existsSync(path.join(resPath, 'mipmap-anydpi'))
        ? 'mipmap-anydpi'
        : null;
    if (anydpiDir) {
      const adaptiveIconPath = path.join(resPath, anydpiDir, 'ic_launcher.xml');
      if (fs.existsSync(adaptiveIconPath)) fs.writeFileSync(adaptiveIconPath, adaptiveIconXml);
      const roundIconPath = path.join(resPath, anydpiDir, 'ic_launcher_round.xml');
      if (fs.existsSync(roundIconPath)) fs.writeFileSync(roundIconPath, adaptiveIconXml);
    }
    log.info('[Builder] Icon patched successfully');
  }
}

async function buildApkAsync(serverUrl: string, homePageUrl: string, bootstrapToken: string, enrollmentId: string, appName: string, iconBuffer: Buffer | null): Promise<void> {
  let buildDir: string | null = null;
  let buildCompleted = false;

  try {
    setProgress('checking', 'Checking build prerequisites...', false, null, appName);

    try {
      const { stderr } = await runProcess('java', ['-version'], 10000);
      log.info(`[Builder] Java found: ${stderr.split('\n')[0]}`);
    } catch {
      setProgress('checking', 'Java not found', true, 'Java Runtime is required but not installed.', appName);
      return;
    }

    if (checkCancelled()) return;

    if (!fs.existsSync(paths.baseApkPath)) { setProgress('checking', 'Base APK not found', true, `Base APK not found at: ${paths.baseApkPath}`, appName); return; }
    if (!fs.existsSync(paths.apkToolPath)) { setProgress('checking', 'apktool.jar not found', true, `apktool.jar not found at: ${paths.apkToolPath}`, appName); return; }
    if (!fs.existsSync(paths.signerPath)) { setProgress('checking', 'uber-apk-signer.jar not found', true, `uber-apk-signer.jar not found at: ${paths.signerPath}`, appName); return; }

    ensureDataDir();
    buildDir = createBuildDir();
    const decompilePath = path.join(buildDir, 'decompiled');
    const outputApk = path.join(buildDir, 'build.apk');

    if (checkCancelled()) return;

    setProgress('decompiling', 'Decompiling base APK with apktool...', false, null, appName);
    await runProcess('java', ['-jar', paths.apkToolPath, 'd', paths.baseApkPath, '-o', decompilePath, '-f'], 180000);

    if (checkCancelled()) return;

    setProgress('patching', `Patching APK — Server: ${serverUrl}, Name: ${appName}...`, false, null, appName);
    await patchApk(decompilePath, serverUrl, homePageUrl, bootstrapToken, appName, iconBuffer);

    if (checkCancelled()) return;

    setProgress('building', 'Rebuilding APK with apktool...', false, null, appName);
    await runProcess('java', ['-jar', paths.apkToolPath, 'b', decompilePath, '-o', outputApk], 180000);

    if (checkCancelled()) return;

    setProgress('signing', 'Signing APK with uber-apk-signer...', false, null, appName);
    await runProcess('java', ['-jar', paths.signerPath, '--apks', outputApk, '--overwrite'], 60000);

    const signedApk = path.join(buildDir, 'build-aligned-debugSigned.apk');
    const apkToRead = fs.existsSync(signedApk) ? signedApk : outputApk;
    if (!fs.existsSync(apkToRead)) throw new Error('Built APK file not found after signing');

    const apkData = fs.readFileSync(apkToRead);
    const fileSize = apkData.length;
    log.info(`[Builder] Signed APK ready (${(fileSize / 1024 / 1024).toFixed(2)} MB), storing in database...`);

    const d = getDb();
    // Trim to the most recent 5 build records with a single DELETE
    d.run(sql`DELETE FROM build_records WHERE id NOT IN (SELECT id FROM build_records ORDER BY id DESC LIMIT 4)`);
    
    const result = d.insert(buildRecords).values({
      serverUrl, homePageUrl, appName,
      status: 'completed',
      apkData,
      fileSize,
      completedAt: new Date().toISOString(),
    }).run();
    buildState.lastBuildId = Number(result.lastInsertRowid);
    buildCompleted = true;

    cleanupDir(buildDir);
    buildDir = null;

    setProgress('signing', 'Build completed successfully!', true, null, appName);
  } catch (err: any) {
    if (buildState.cancelled) {
      setProgress('checking', 'Build cancelled', true, 'Build was cancelled by user', appName);
    } else {
      const errMsg = err.message || 'Unknown build error';
      log.error(`[Builder] Build failed: ${errMsg}`);
      setProgress('signing', `Build failed: ${errMsg}`, true, errMsg, appName);
    }
  } finally {
    if (!buildCompleted) {
      try { revokeEnrollment(enrollmentId); }
      catch (err: unknown) { log.warn(`[Builder] Failed to revoke unused enrollment: ${err instanceof Error ? err.message : String(err)}`); }
    }
    killAllProcesses();
    if (buildDir) cleanupDir(buildDir);
    buildState.inProgress = false;
    buildState.cancelled = false;
  }
}

export async function builderRoutes(app: FastifyInstance) {
  const builderAccess = [app.auth, requirePermission('builder:access')];

  app.post('/api/builder/build', {
    preHandler: builderAccess,
  }, async (request, reply) => {
    if (buildState.inProgress) {
      return reply.code(409).send({ success: false, error: 'A build is already in progress' });
    }

    let serverUrl = DEFAULT_SERVER_URL;
    let homePageUrl = DEFAULT_HOME_URL;
    let appName = 'Fason';
    let iconBuffer: Buffer | null = null;

    try {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'field') {
          const field = part as { fieldname: string; value: string };
          switch (field.fieldname) {
            case 'serverUrl': serverUrl = String(field.value) || DEFAULT_SERVER_URL; break;
            case 'homePageUrl': homePageUrl = String(field.value) || DEFAULT_HOME_URL; break;
            case 'appName': appName = String(field.value) || 'Fason'; break;
          }
        } else if (part.type === 'file') {
          const file = part as { fieldname: string; toBuffer: () => Promise<Buffer> };
          if (file.fieldname === 'appIcon') {
            try {
              iconBuffer = await file.toBuffer();
              if (iconBuffer.length > MAX_ICON_SIZE) {
                return reply.code(400).send({ success: false, error: `Icon file too large (${(iconBuffer.length / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.` });
              }
              log.info(`[Builder] Icon uploaded: ${iconBuffer.length} bytes`);
            } catch (err: any) {
              log.warn(`[Builder] Failed to read icon file: ${err.message}`);
            }
          }
        }
      }
    } catch (err: any) {
      log.warn(`[Builder] Failed to parse form data: ${err.message}`);
      return reply.code(400).send({ success: false, error: 'Failed to parse form data' });
    }

    serverUrl = serverUrl.trim();
    homePageUrl = homePageUrl.trim();
    if (!serverUrl.match(/^https?:\/\/.+/)) return reply.code(400).send({ success: false, error: 'Invalid server URL' });
    if (!homePageUrl.match(/^https?:\/\/.+/)) return reply.code(400).send({ success: false, error: 'Invalid home page URL' });
    if (!appName || appName.trim().length === 0) return reply.code(400).send({ success: false, error: 'App name is required' });
    if (appName.trim().length > MAX_APP_NAME_LENGTH) return reply.code(400).send({ success: false, error: `App name must be ${MAX_APP_NAME_LENGTH} characters or less` });
    // Allow HTTP for local IP addresses and development/testing
    // if (process.env.NODE_ENV === 'production' && !serverUrl.startsWith('https://')) {
    //   return reply.code(400).send({ success: false, error: 'APK server URL must use HTTPS in production' });
    // }

    appName = appName.trim();
    const enrollment = createPendingEnrollment(appName);

    buildState.inProgress = true;
    buildState.cancelled = false;
    void buildApkAsync(serverUrl, homePageUrl, enrollment.token, enrollment.id, appName, iconBuffer).catch((err: unknown) => {
      log.error(`[Builder] Unhandled build error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { success: true, message: 'Build started' };
  });

  app.post('/api/builder/cancel', {
    preHandler: builderAccess,
  }, async (request, reply) => {
    if (!buildState.inProgress) {
      return reply.code(404).send({ success: false, error: 'No build in progress' });
    }
    buildState.cancelled = true;
    killAllProcesses();
    return { success: true, message: 'Build cancellation requested' };
  });

  app.get('/api/builder/download', {
    preHandler: builderAccess,
  }, async (request, reply) => {
    const d = getDb();
    const record = d.select({ id: buildRecords.id, appName: buildRecords.appName, apkData: buildRecords.apkData, fileSize: buildRecords.fileSize })
      .from(buildRecords)
      .where(eq(buildRecords.status, 'completed'))
      .orderBy(desc(buildRecords.id))
      .limit(1)
      .get();

    if (!record?.apkData) {
      return reply.code(404).send({ success: false, error: 'No APK built yet' });
    }

    const apkBuffer = Buffer.from(record.apkData as Uint8Array);
    const downloadName = sanitizeFileName(record.appName || 'Fason') + '.apk';
    reply.header('Content-Type', 'application/vnd.android.package-archive');
    reply.header('Content-Disposition', `attachment; filename="${downloadName}"`);
    reply.header('Content-Length', record.fileSize || apkBuffer.length);
    return reply.send(apkBuffer);
  });
}
