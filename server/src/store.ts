import { Firestore } from "@google-cloud/firestore";

export type CollectionName =
  | "clients"
  | "pending_auth"
  | "authorization_codes"
  | "grants"
  | "access_tokens"
  | "refresh_tokens"
  | "transaction_change_checkpoints";

export interface RecordStore {
  get<T extends object>(collection: CollectionName, id: string): Promise<T | undefined>;
  put<T extends object>(collection: CollectionName, id: string, value: T): Promise<void>;
  take<T extends object>(collection: CollectionName, id: string): Promise<T | undefined>;
  delete(collection: CollectionName, id: string): Promise<void>;
  deleteWhere(collection: CollectionName, field: string, value: string): Promise<void>;
}

export class MemoryStore implements RecordStore {
  private readonly collections = new Map<CollectionName, Map<string, object>>();

  private collection(name: CollectionName): Map<string, object> {
    let records = this.collections.get(name);
    if (!records) {
      records = new Map();
      this.collections.set(name, records);
    }
    return records;
  }

  async get<T extends object>(collection: CollectionName, id: string): Promise<T | undefined> {
    return this.collection(collection).get(id) as T | undefined;
  }

  async put<T extends object>(collection: CollectionName, id: string, value: T): Promise<void> {
    this.collection(collection).set(id, structuredClone(value));
  }

  async take<T extends object>(collection: CollectionName, id: string): Promise<T | undefined> {
    const records = this.collection(collection);
    const value = records.get(id) as T | undefined;
    records.delete(id);
    return value ? structuredClone(value) : undefined;
  }

  async delete(collection: CollectionName, id: string): Promise<void> {
    this.collection(collection).delete(id);
  }

  async deleteWhere(collection: CollectionName, field: string, value: string): Promise<void> {
    for (const [id, record] of this.collection(collection)) {
      if ((record as Record<string, unknown>)[field] === value) this.collection(collection).delete(id);
    }
  }
}

export class FirestoreStore implements RecordStore {
  private readonly firestore: Firestore;

  constructor(projectId?: string) {
    this.firestore = new Firestore(projectId ? { projectId } : undefined);
  }

  private collection(name: CollectionName) {
    return this.firestore.collection(`financial_analysis_for_ynab_${name}`);
  }

  async get<T extends object>(collection: CollectionName, id: string): Promise<T | undefined> {
    const snapshot = await this.collection(collection).doc(id).get();
    return snapshot.exists ? (snapshot.data() as T) : undefined;
  }

  async put<T extends object>(collection: CollectionName, id: string, value: T): Promise<void> {
    await this.collection(collection).doc(id).set(value);
  }

  async take<T extends object>(collection: CollectionName, id: string): Promise<T | undefined> {
    const ref = this.collection(collection).doc(id);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return undefined;
      transaction.delete(ref);
      return snapshot.data() as T;
    });
  }

  async delete(collection: CollectionName, id: string): Promise<void> {
    await this.collection(collection).doc(id).delete();
  }

  async deleteWhere(collection: CollectionName, field: string, value: string): Promise<void> {
    const snapshot = await this.collection(collection).where(field, "==", value).get();
    const batch = this.firestore.batch();
    for (const document of snapshot.docs) batch.delete(document.ref);
    if (!snapshot.empty) await batch.commit();
  }
}
