/** @jsxImportSource preact */
import { useContext } from 'preact/hooks';
import { Store } from '../store';

export function Stats() {
  const { state } = useContext(Store);
  const done = state.todos.filter((t) => t.done).length;
  return (
    <p>
      {done} of {state.todos.length} done
    </p>
  );
}
