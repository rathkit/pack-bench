/** @jsxImportSource preact */
import { useContext } from 'preact/hooks';
import { Store } from '../store';
import type { Todo } from '../types';

export function TodoItem({ todo }: { todo: Todo }) {
  const { dispatch } = useContext(Store);
  return (
    <li class={todo.done ? 'done' : 'open'} data-id={todo.id}>
      <input type="checkbox" checked={todo.done} onChange={() => dispatch({ type: 'toggle', id: todo.id })} />
      <span>{todo.title}</span>
      {todo.tags.map((tag) => (
        <em key={tag}>#{tag}</em>
      ))}
      <button onClick={() => dispatch({ type: 'remove', id: todo.id })}>remove</button>
    </li>
  );
}
