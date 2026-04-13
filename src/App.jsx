import { useEffect, useState } from "react"
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut
} from "firebase/auth"

import { auth } from "./firebase"
import WorkoutTracker from "./WorkoutTracker"

export default function App() {
  const [user, setUser] = useState(null)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u)
    })
    return () => unsub()
  }, [])

  const login = () => signInWithEmailAndPassword(auth, email, password)
  const signup = () => createUserWithEmailAndPassword(auth, email, password)
  const logout = () => signOut(auth)

  if (!user) {
    return (
      <div style={{ padding: 20 }}>
        <h2>Login</h2>

        <input
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <br /><br />

        <button onClick={login}>Login</button>
        <button onClick={signup}>Sign Up</button>
      </div>
    )
  }

  return (
    <div>
      <button onClick={logout}>Logout</button>
      <WorkoutTracker user={user} />
    </div>
  )
}
