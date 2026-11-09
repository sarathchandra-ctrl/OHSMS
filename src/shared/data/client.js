// The Firestore-shaped calls module code uses (collection, doc, getDocs,
// onSnapshot, writeBatch…), backed by this installation's Postgres through
// the data seam. Kept under these names so the modules read the same as they
// always did; the implementation is ./postgresClient.js.
export {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from './postgresClient'
