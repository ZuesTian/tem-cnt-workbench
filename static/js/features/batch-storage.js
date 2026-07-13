// @ts-check

const DATABASE_NAME = "tem-cnt-batch-v1";
const DATABASE_VERSION = 1;

/** @param {IDBRequest} request */
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB 操作失败"));
  });
}

/** @param {IDBTransaction} transaction */
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(undefined);
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB 事务失败"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB 事务已中止"));
  });
}

export class BatchStorage {
  /** @param {IDBFactory | undefined} factory */
  constructor(factory = globalThis.indexedDB) {
    this.factory = factory;
    this.databasePromise = null;
    this.memoryBatch = null;
    this.memoryArtifacts = new Map();
  }

  async database() {
    if (!this.factory) return null;
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("batches")) {
            database.createObjectStore("batches", { keyPath: "id" });
          }
          if (!database.objectStoreNames.contains("artifacts")) {
            const artifacts = database.createObjectStore("artifacts", {
              keyPath: "key",
            });
            artifacts.createIndex("batchId", "batchId", { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("无法打开本地批处理缓存"));
      });
    }
    return this.databasePromise;
  }

  async saveBatch(record) {
    const database = await this.database();
    if (!database) {
      this.memoryBatch = record;
      return;
    }
    const transaction = database.transaction("batches", "readwrite");
    transaction.objectStore("batches").put(record);
    await transactionDone(transaction);
  }

  async loadBatch() {
    const database = await this.database();
    if (!database) return this.memoryBatch;
    const transaction = database.transaction("batches", "readonly");
    return (await requestResult(transaction.objectStore("batches").get("active"))) || null;
  }

  async clearBatch() {
    this.memoryBatch = null;
    const database = await this.database();
    if (!database) return;
    const transaction = database.transaction("batches", "readwrite");
    transaction.objectStore("batches").delete("active");
    await transactionDone(transaction);
  }

  async putArtifact(batchId, filename, blob) {
    const record = {
      key: `${batchId}:${filename}`,
      batchId,
      filename,
      blob,
      updatedAt: new Date().toISOString(),
    };
    const database = await this.database();
    if (!database) {
      this.memoryArtifacts.set(record.key, record);
      return;
    }
    const transaction = database.transaction("artifacts", "readwrite");
    transaction.objectStore("artifacts").put(record);
    await transactionDone(transaction);
  }

  async getArtifact(batchId, filename) {
    const key = `${batchId}:${filename}`;
    const database = await this.database();
    if (!database) return this.memoryArtifacts.get(key) || null;
    const transaction = database.transaction("artifacts", "readonly");
    return (await requestResult(transaction.objectStore("artifacts").get(key))) || null;
  }

  async listArtifacts(batchId) {
    const database = await this.database();
    if (!database) {
      return [...this.memoryArtifacts.values()].filter(
        (record) => record.batchId === batchId,
      );
    }
    const transaction = database.transaction("artifacts", "readonly");
    const index = transaction.objectStore("artifacts").index("batchId");
    return /** @type {Promise<Array<{filename:string, blob:Blob}>>} */ (
      requestResult(index.getAll(batchId))
    );
  }
}
