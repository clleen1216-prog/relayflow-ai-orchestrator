import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import type { LinkedAccount, WorkspaceState } from './types';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export async function signInWithGooglePopup(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  await ensureUserProfile(result.user);
  return result.user;
}

export async function signOutAccount(): Promise<void> {
  await signOut(auth);
}

export async function ensureUserProfile(user: User): Promise<void> {
  const userPath = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(ref);
    const displayName = (user.displayName || user.email?.split('@')[0] || 'RelayFlow 使用者').slice(
      0,
      120
    );
    const email = (user.email || 'user@example.com').slice(0, 254);

    if (!snap.exists()) {
      await setDoc(ref, {
        uid: user.uid,
        email,
        displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(
        ref,
        {
          email,
          displayName,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}

function stripUndefinedDeep<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function loadUserWorkspace(uid: string): Promise<WorkspaceState | null> {
  const wsPath = `users/${uid}/workspaces/default`;
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'workspaces', 'default'));
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      currentDate: String(data.currentDate),
      routingMode: data.routingMode,
      dailyTimeBudgetMinutes: Number(data.dailyTimeBudgetMinutes),
      tools: Array.isArray(data.tools) ? data.tools : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      carryoverLogs: Array.isArray(data.carryoverLogs) ? data.carryoverLogs : [],
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, wsPath);
  }
}

export async function saveUserWorkspace(
  uid: string,
  state: WorkspaceState
): Promise<void> {
  const wsPath = `users/${uid}/workspaces/default`;
  try {
    const boundedTasks = state.tasks.slice(0, 80).map((t) => ({
      ...t,
      finalDeliverable: t.finalDeliverable ? t.finalDeliverable.slice(0, 12000) : undefined,
      steps: t.steps.slice(0, 20).map((s) => ({
        ...s,
        output: s.output ? s.output.slice(0, 8000) : '',
      })),
    }));
    const clean = stripUndefinedDeep({
      ownerId: uid,
      currentDate: state.currentDate.slice(0, 20),
      routingMode: state.routingMode,
      dailyTimeBudgetMinutes: Math.min(720, Math.max(30, Math.round(state.dailyTimeBudgetMinutes))),
      tools: state.tools.slice(0, 50),
      tasks: boundedTasks,
      carryoverLogs: state.carryoverLogs.slice(0, 100),
    });
    await setDoc(doc(db, 'users', uid, 'workspaces', 'default'), {
      ...clean,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, wsPath);
  }
}

export async function loadLinkedAccounts(uid: string): Promise<LinkedAccount[]> {
  const colPath = `users/${uid}/accounts`;
  try {
    const accountsQuery = query(
      collection(db, 'users', uid, 'accounts'),
      where('ownerId', '==', uid)
    );
    const snap = await getDocs(accountsQuery);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        label: String(data.label ?? ''),
        emailAlias: String(data.emailAlias ?? ''),
        toolIds: Array.isArray(data.toolIds) ? data.toolIds.map(String) : [],
        notes: String(data.notes ?? ''),
        enabled: Boolean(data.enabled),
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, colPath);
  }
}

export async function saveLinkedAccount(
  uid: string,
  account: LinkedAccount,
  isNew: boolean
): Promise<void> {
  const accPath = `users/${uid}/accounts/${account.id}`;
  try {
    const ref = doc(db, 'users', uid, 'accounts', account.id);
    if (isNew) {
      await setDoc(ref, {
        id: account.id.slice(0, 128),
        ownerId: uid,
        label: account.label.slice(0, 80),
        emailAlias: account.emailAlias.slice(0, 160),
        toolIds: account.toolIds.slice(0, 30),
        notes: account.notes.slice(0, 300),
        enabled: account.enabled,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(
        ref,
        {
          label: account.label.slice(0, 80),
          emailAlias: account.emailAlias.slice(0, 160),
          toolIds: account.toolIds.slice(0, 30),
          notes: account.notes.slice(0, 300),
          enabled: account.enabled,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
  } catch (error) {
    handleFirestoreError(error, isNew ? OperationType.CREATE : OperationType.UPDATE, accPath);
  }
}

export async function deleteLinkedAccount(uid: string, accountId: string): Promise<void> {
  const accPath = `users/${uid}/accounts/${accountId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'accounts', accountId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, accPath);
  }
}
