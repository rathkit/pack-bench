/** @jsxImportSource preact */
import { useContext } from 'preact/hooks';
import { Store } from '../store';
import type { Filter } from '../types';

const filters: Filter[] = ['all', 'open', 'done'];

export function Filters() {
  const { state, dispatch } = useContext(Store);
  return (
    <nav>
      {filters.map((f) => (
        <button key={f} aria-pressed={state.filter === f} onClick={() => dispatch({ type: 'filter', filter: f })}>
          {f}
        </button>
      ))}
    </nav>
  );
}
