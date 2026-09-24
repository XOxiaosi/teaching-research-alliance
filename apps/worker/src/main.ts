export const workerName = "teaching-research-alliance-worker";

export {
  BackgroundWorkerRuntime,
  WorkerTaskTransientError,
} from "./background-worker-runtime.js";
export type {
  BackgroundWorkerRuntimeOptions,
  ClaimedWorkerTask,
  WorkerLogger,
  WorkerQueue,
  WorkerTask,
  WorkerTaskContext,
  WorkerTaskPayload,
  WorkerTaskRegistration,
} from "./background-worker-runtime.js";
