import { useRef, useState } from "react"
export function useTask() {
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function run(work: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败")
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return { busy, error, run }
}
