import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Local state that the user can change, but which resets to `external`
 * whenever `external` changes. Uses React's recommended render-phase
 * adjustment (storing the previous external value) instead of a syncing
 * effect — no extra render pass, no `set-state-in-effect`.
 * See https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
 */
export function useResettableState<T>(external: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(external);
  const [prev, setPrev] = useState(external);
  if (prev !== external) {
    setPrev(external);
    setValue(external);
  }
  return [value, setValue];
}
