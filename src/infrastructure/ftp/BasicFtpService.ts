import { Client } from 'basic-ftp';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { FtpService, FtpServiceConfig } from '../../shared/ports.js';

export class BasicFtpService implements FtpService {
  private readonly config: FtpServiceConfig;

  constructor(config: FtpServiceConfig) {
    this.config = config;
  }

  private async connect(): Promise<Client> {
    const client = new Client();
    client.ftp.verbose = this.config.verbose || false;

    try {
      await client.access({
        host:     this.config.host,
        user:     this.config.user,
        password: this.config.password,
        secure:   this.config.secure || false,
      });
      return client;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Failed to connect to FTP server ${this.config.host}:`, error);
      throw new Error(
        `FTP connection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async downloadFile(remotePath: string): Promise<string> {
    const client = await this.connect();
    let tempFilePath: string | null = null;

    try {
      tempFilePath = path.join(
        os.tmpdir(),
        `pwnery-${Date.now()}-${Math.random().toString(36).substring(7)}.tmp`,
      );

      await client.downloadTo(tempFilePath, remotePath);

      const content = await fs.readFile(tempFilePath, 'utf-8');

      return content;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error downloading file from FTP (${remotePath}):`, error);
      throw new Error(
        `Failed to download file: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      client.close();

      if (tempFilePath) {
        try {
          await fs.unlink(tempFilePath);
        } catch (unlinkError) {
          console.warn(`Failed to delete temporary file ${tempFilePath}:`, unlinkError);
        }
      }
    }
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const client = await this.connect();

    try {
      await fs.access(localPath);

      await client.uploadFrom(localPath, remotePath);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error uploading file to FTP (${remotePath}):`, error);
      throw new Error(
        `Failed to upload file: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      client.close();
    }
  }

  async listFiles(remotePath: string): Promise<string[]> {
    const client = await this.connect();

    try {
      const listing = await client.list(remotePath);
      return listing
        .filter((entry) => entry.type !== 2)
        .map((entry) => entry.name);
    } catch (error) {
      console.error(`Error listing directory ${remotePath}:`, error);
      throw new Error(
        `Failed to list directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      client.close();
    }
  }

  async downloadToLocal(remotePath: string, localPath: string): Promise<void> {
    const client = await this.connect();

    try {
      await client.downloadTo(localPath, remotePath);
    } catch (error) {
      console.error(`Error downloading ${remotePath} to ${localPath}:`, error);
      throw new Error(
        `Failed to download file: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      client.close();
    }
  }

  async downloadMany(
    files: { remotePath: string; localPath: string }[],
    onProgress?: (completed: number, total: number) => void,
  ): Promise<string[]> {
    if (files.length === 0) return [];

    const client = await this.connect();
    const downloaded: string[] = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const { remotePath, localPath } = files[i];
        try {
          await client.downloadTo(localPath, remotePath);
          downloaded.push(path.basename(localPath));
        } catch (err) {
          console.error(`Error downloading ${remotePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
        onProgress?.(i + 1, files.length);
      }
    } finally {
      client.close();
    }

    return downloaded;
  }

  async getLastModified(remotePath: string): Promise<Date> {
    const client = await this.connect();

    try {
      return await client.lastMod(remotePath);
    } catch (error) {
      console.error(`Error getting lastMod for ${remotePath}:`, error);
      throw new Error(
        `Failed to get last modified date: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      client.close();
    }
  }

  async ensureDir(remotePath: string): Promise<void> {
    const client = await this.connect();

    try {
      await client.ensureDir(remotePath);
    } catch (error) {
      console.error(`Error ensuring directory ${remotePath}:`, error);
      throw new Error(
        `Failed to ensure directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      client.close();
    }
  }

  async deleteMany(remotePaths: string[]): Promise<number> {
    if (remotePaths.length === 0) return 0;

    const client = await this.connect();
    let deleted = 0;

    try {
      for (const remotePath of remotePaths) {
        try {
          await client.remove(remotePath);
          deleted++;
        } catch (err) {
          console.error(`Error deleting ${remotePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      client.close();
    }

    return deleted;
  }

  async deleteFile(remotePath: string): Promise<void> {
    const client = await this.connect();

    try {
      await client.remove(remotePath);
    } catch (error) {
      console.error(`Error deleting ${remotePath}:`, error);
      throw new Error(
        `Failed to delete file: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      client.close();
    }
  }
}
