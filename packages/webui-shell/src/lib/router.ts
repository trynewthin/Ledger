import { useEffect, useState } from 'react'

/** 极简 hash 路由：#/path → path */
export function useHashRoute(): [string, (to: string) => void] {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/')
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.slice(1) || '/')
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const navigate = (to: string) => {
    window.location.hash = to
  }
  return [route, navigate]
}
