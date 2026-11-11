/** @jsxImportSource preact */
import { useReducer } from 'preact/hooks';
import { Filters } from './components/Filters';
import { Stats } from './components/Stats';
import { TodoList } from './components/TodoList';
import { Store, initial, reducer } from './store';

export function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  return (
    <Store.Provider value={{ state, dispatch }}>
      <main>
        <h1>Todos</h1>
        <Filters />
        <TodoList />
        <Stats />
      </main>
    </Store.Provider>
  );
}
