import { ExpressAdapter } from "@bull-board/express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/dist/queueAdapters/bullMQ";
import { transactionQueue } from "./transactionQueue";
import { syncQueue } from "./syncQueue";

export function createQueueDashboard() {
  const serverAdapter = new ExpressAdapter();

  createBullBoard({
    queues: [
      new BullMQAdapter(transactionQueue, { readOnlyMode: false }),
      new BullMQAdapter(syncQueue, { readOnlyMode: false }),
    ],
    serverAdapter: serverAdapter,
    options: {
      uiConfig: {
        boardTitle: "Mobile Money Queue Dashboard",
      },
    },
  });

  serverAdapter.setBasePath("/admin/queues");

  return serverAdapter.getRouter();
}
