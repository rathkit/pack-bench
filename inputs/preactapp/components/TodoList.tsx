/** @jsxImportSource preact */
import { useContext, useMemo } from 'preact/hooks';
import { Store } from '../store';
import { TodoItem } from './TodoItem';

export function TodoList() {
  const { state } = useContext(Store);
  const shown = useMemo(() => state.todos.filter((t) => state.filter === 'all' || (state.filter === 'done') === t.done), [state.todos, state.filter]);
  return <ul>{shown.length ? shown.map((todo) => <TodoItem key={todo.id} todo={todo} />) : <li>nothing to show</li>}</ul>;
}
