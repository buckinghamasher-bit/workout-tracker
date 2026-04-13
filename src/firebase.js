import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import {getAuth } from "firebase/auth"

const firebaseConfig = {
  apiKey: "AIzaSyATTmBahRnyOby3mQMk2_q1uNGYv0eeoRc",
  authDomain: "workouttracker-b1f24.firebaseapp.com",
  projectId: "workouttracker-b1f24",
  storageBucket: "workouttracker-b1f24.appspot.com",
  messagingSenderId: "223983805897",
  appId: "1:223983805897:web:8e68939018adbb74d9f418",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app)
