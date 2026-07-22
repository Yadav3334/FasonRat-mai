import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const DATA_DIR = path.resolve(ROOT_DIR, 'data');

const paths = {
  rootDir: ROOT_DIR,
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'fasonrat.db'),
  factoryDir: path.join(ROOT_DIR, 'app', 'factory'),
  baseApkPath: path.join(ROOT_DIR, 'app', 'factory', 'baseApp', 'Fason.apk'),
  apkToolPath: path.join(ROOT_DIR, 'app', 'factory', 'apktool.jar'),
  signerPath: path.join(ROOT_DIR, 'app', 'factory', 'uber-apk-signer.jar'),
};

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function createBuildDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fason-build-'));
}

export { paths, ensureDataDir, createBuildDir };
