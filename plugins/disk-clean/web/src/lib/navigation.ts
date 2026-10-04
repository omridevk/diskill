import {useRouter, type NavigateOptions} from '@tanstack/react-router'
import {useState} from 'react'

export function useBack() {
  const router = useRouter()
  return (fallback: NavigateOptions) => {
    if (router.history.canGoBack()) router.history.back()
    else router.navigate({...fallback, replace: true})
  }
}

export function useDialogExit() {
  const [then, setThen] = useState<(() => void) | null>(null)
  return {
    open: then === null,
    leave: (next: () => void) => setThen(() => next),
    then,
  }
}
