export interface FtpServiceConfig {
  host: string;
  user: string;
  password: string;
  secure?: boolean;
  verbose?: boolean;
}

export interface FtpService {
  downloadFile(remotePath: string): Promise<string>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  listFiles(remotePath: string): Promise<string[]>;
  downloadToLocal(remotePath: string, localPath: string): Promise<void>;
  downloadMany(
    files: { remotePath: string; localPath: string }[],
    onProgress?: (completed: number, total: number) => void,
  ): Promise<string[]>;
  getLastModified(remotePath: string): Promise<Date>;
  ensureDir(remotePath: string): Promise<void>;
  deleteMany(remotePaths: string[]): Promise<number>;
  deleteFile(remotePath: string): Promise<void>;
}

export interface Notifier {
  send(title: string, description: string, level: 'info' | 'warning' | 'error'): Promise<void>;
}
