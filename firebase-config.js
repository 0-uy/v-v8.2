// ═══════════════════════════════════════════════════════════
//  firebase-config.js — Configuración central de Firebase
//  SSIP v3.1 · Multi-tenant · Planes · Auto-borrado 48hs
//  + onSnapshot para notificaciones en tiempo real
// ═══════════════════════════════════════════════════════════

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updatePassword,
  EmailAuthProvider,
  reauthenticateWithCredential,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  where,
  orderBy,
  updateDoc,
  serverTimestamp,
  onSnapshot          // ← NUEVO: escucha cambios en tiempo real
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ─── CREDENCIALES FIREBASE ───────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyC4lNSyk8VvQGu0Nb7zfvUsfc34K-xtUzk",
  authDomain:        "ssip-seguridad.firebaseapp.com",
  projectId:         "ssip-seguridad",
  storageBucket:     "ssip-seguridad.firebasestorage.app",
  messagingSenderId: "905868905769",
  appId:             "1:905868905769:web:cf9ff453f99b18e1cdfb38"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ─── ADMIN ───────────────────────────────────────────────
const ADMIN_EMAIL = "ssip.admi@gmail.com";

// ─── DEFINICIÓN DE PLANES ────────────────────────────────
export const PLANES = {
  basico: {
    id:          'basico',
    nombre:      'Básico',
    camaras:     1,
    multiview:   false,
    historial:   48,
    color:       '#00d4ff',
    badge:       'BÁSICO',
  },
  pro: {
    id:          'pro',
    nombre:      'Profesional',
    camaras:     3,
    multiview:   true,
    historial:   48,
    color:       '#ffb800',
    badge:       'PRO',
  },
};

// ═══════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════

export async function login(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function logout() {
  await signOut(auth);
  window.location.href = 'login.html';
}

export function onAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export function currentUser() {
  return auth.currentUser;
}

export function isAdmin(user) {
  return user && user.email === ADMIN_EMAIL;
}

// ─── CAMBIO DE CONTRASEÑA ────────────────────────────────
export async function cambiarPassword(passwordActual, passwordNueva) {
  const user = auth.currentUser;
  if (!user) throw new Error("No hay usuario autenticado.");
  if (!user.email) throw new Error("El usuario no tiene email asociado.");
  if (!passwordActual || !passwordNueva) throw new Error("Faltan datos para cambiar la contraseña.");
  const cred = EmailAuthProvider.credential(user.email, passwordActual);
  await reauthenticateWithCredential(user, cred);
  await updatePassword(user, passwordNueva);
}

// ─── RESET DE CONTRASEÑA ─────────────────────────────────
export async function enviarResetPassword(email = null) {
  const destino = email || auth.currentUser?.email;
  if (!destino) throw new Error("No se encontró un email para enviar el restablecimiento.");
  await sendPasswordResetEmail(auth, destino);
}

// ═══════════════════════════════════════════════════════════
//  EMPRESAS
// ═══════════════════════════════════════════════════════════

export async function getEmpresa(uid) {
  const snap = await getDoc(doc(db, 'empresas', uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function getAllEmpresas() {
  const snap = await getDocs(collection(db, 'empresas'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function createEmpresa(uid, data) {
  await setDoc(doc(db, 'empresas', uid), {
    ...data,
    plan:     data.plan || 'basico',
    creadoEn: serverTimestamp(),
    activo:   true,
  });
}

export async function updateEmpresa(uid, data) {
  await updateDoc(doc(db, 'empresas', uid), data);
}

export async function getPlanEmpresa(uid) {
  const empresa = await getEmpresa(uid);
  const planId  = empresa?.plan || 'basico';
  return PLANES[planId] || PLANES.basico;
}

// ═══════════════════════════════════════════════════════════
//  EVENTOS — auto-borrado 48hs desde el cliente
// ═══════════════════════════════════════════════════════════

export async function guardarEvento(empresaId, evento) {
  const ahora = Date.now();
  await addDoc(collection(db, 'eventos'), {
    empresaId,
    tipo:      evento.tipo,
    severidad: evento.severidad,
    snapshot:  evento.snapshot || '',
    camaraIdx: evento.camaraIdx ?? 0,
    favorito:  false,
    tsMs:      ahora,
    expiraEn:  ahora + (48 * 60 * 60 * 1000),
  });
}

export async function getEventos(empresaId) {
  await limpiarEventosViejos(empresaId);
  const hace48h = Date.now() - (48 * 60 * 60 * 1000);
  const q = query(
    collection(db, 'eventos'),
    where('empresaId', '==', empresaId),
    where('tsMs', '>', hace48h),
    orderBy('tsMs', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function limpiarEventosViejos(empresaId) {
  const hace48h = Date.now() - (48 * 60 * 60 * 1000);
  const q = query(
    collection(db, 'eventos'),
    where('empresaId', '==', empresaId),
    where('tsMs', '<', hace48h)
  );
  const snap = await getDocs(q);
  await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
}

// ─── LISTENER EN TIEMPO REAL ─────────────────────────────
// Llama a `callback` con { type: 'added'|'modified'|'removed', evento }
// cada vez que Firestore detecta un cambio.
// Devuelve la función `unsubscribe` para detener la escucha.
export function suscribirEventos(empresaId, callback) {
  const hace48h = Date.now() - (48 * 60 * 60 * 1000);
  const q = query(
    collection(db, 'eventos'),
    where('empresaId', '==', empresaId),
    where('tsMs', '>', hace48h),
    orderBy('tsMs', 'desc')
  );
  return onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach(change => {
      callback({
        type:   change.type,                          // 'added' | 'modified' | 'removed'
        evento: { id: change.doc.id, ...change.doc.data() },
      });
    });
  });
}

export async function toggleFavorito(eventoId, valorActual) {
  await updateDoc(doc(db, 'eventos', eventoId), { favorito: !valorActual });
}

export async function deleteEvento(eventoId) {
  await deleteDoc(doc(db, 'eventos', eventoId));
}

// ═══════════════════════════════════════════════════════════
//  ZONAS — configuración por empresa y por cámara
// ═══════════════════════════════════════════════════════════

export async function getZonas(empresaId, camaraIdx = 0) {
  const snap = await getDocs(
    collection(db, 'empresas', empresaId, `zonas_cam${camaraIdx}`)
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function saveZona(empresaId, zonaId, data, camaraIdx = 0) {
  await setDoc(
    doc(db, 'empresas', empresaId, `zonas_cam${camaraIdx}`, zonaId),
    { ...data, actualizadoEn: serverTimestamp() }
  );
}

export async function deleteZona(empresaId, zonaId, camaraIdx = 0) {
  await deleteDoc(
    doc(db, 'empresas', empresaId, `zonas_cam${camaraIdx}`, zonaId)
  );
}

export async function getZonasPrincipal(empresaId) {
  const zonas = await getZonas(empresaId, 0);
  if (zonas.length > 0) return zonas;
  const snap = await getDocs(
    collection(db, 'empresas', empresaId, 'zonas')
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export { db, auth };