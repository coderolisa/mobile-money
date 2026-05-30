import { connection } from "./config";
import { transactionQueue } from "./transactionQueue";
import { transactionWorker, closeWorker } from "./worker";
import { syncQueue } from "./syncQueue";
import { syncWorker, closeSyncWorker } from "./syncWorker";

export async function shutdownQueue(): Promise<void> {
  await Promise.all([
    closeWorker().catch(() => undefined),
    closeSyncWorker().catch(() => undefined),
    transactionQueue.close().catch(() => undefined),
    syncQueue.close().catch(() => undefined),
  ]);
  await connection.quit().catch(() => undefined);
}

export {
  transactionQueue,
  addTransactionJob,
  getJobById,
  getJobProgress,
  getQueueStats,
  pauseQueue,
  resumeQueue,
  drainQueue,
} from "./transactionQueue";
export type {
  TransactionJobData,
  TransactionJobResult,
} from "./transactionQueue";

export {
  syncQueue,
  addSyncJob,
  getSyncJobById,
  getSyncQueueStats,
} from "./syncQueue";
export type { SyncJobData, SyncJobResult } from "./syncQueue";

export { transactionWorker, closeWorker };
export { syncWorker, closeSyncWorker };
export { createQueueDashboard } from "./dashboard";
export {
  getQueueHealth,
  pauseQueueEndpoint,
  resumeQueueEndpoint,
} from "./health";
export { queueOptions } from "./config";
