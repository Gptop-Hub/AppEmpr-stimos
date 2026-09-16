import { useCallback, useEffect, useState } from 'react';
import {
  getScreenContextSnapshot,
  subscribeScreenContext,
  updateScreenContextHints,
} from './screenContextStore';

export default function useScreenContext() {
  const [screenContext, setScreenContext] = useState(() => getScreenContextSnapshot());

  useEffect(() => {
    const onWindowChange = () => {
      setScreenContext(getScreenContextSnapshot());
    };

    const unsubscribe = subscribeScreenContext(onWindowChange);
    window.addEventListener('hashchange', onWindowChange);
    window.addEventListener('popstate', onWindowChange);
    onWindowChange();

    return () => {
      unsubscribe();
      window.removeEventListener('hashchange', onWindowChange);
      window.removeEventListener('popstate', onWindowChange);
    };
  }, []);

  const setContextHints = useCallback((hints) => {
    updateScreenContextHints(hints);
  }, []);

  return {
    screenContext,
    setContextHints,
  };
}
