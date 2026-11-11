import { createContext } from 'preact';
import type { Action, State, Todo } from './types';

export const initial: State = {
  todos: [
    { id: 1, title: 'write the benchmark', done: true, tags: ['work'] },
    { id: 2, title: 'run it twice', done: false, tags: ['work', 'later'] },
    { id: 3, title: 'read the output', done: false, tags: [] },
  ],
  filter: 'all',
  nextId: 4,
};

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'add':
      return { ...state, nextId: state.nextId + 1, todos: [...state.todos, { id: state.nextId, title: action.title, done: false, tags: action.tags ?? [] }] };
    case 'toggle':
      return { ...state, todos: state.todos.map((t): Todo => (t.id === action.id ? { ...t, done: !t.done } : t)) };
    case 'remove':
      return { ...state, todos: state.todos.filter((t) => t.id !== action.id) };
    case 'filter':
      return { ...state, filter: action.filter };
  }
}

export const Store = createContext<{ state: State; dispatch: (a: Action) => void }>({ state: initial, dispatch: () => {} });
