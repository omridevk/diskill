import {useRouter, type NavigateOptions} from '@tanstack/react-router'

export function useBack() {
  const router = useRouter()
  return (fallback: NavigateOptions) => {
    if (router.history.canGoBack()) router.history.back()
    else router.navigate({...fallback, replace: true})
  }
}
