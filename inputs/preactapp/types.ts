export type Filter = 'all' | 'open' | 'done';
export interface Todo { id: number; title: string; done: boolean; tags: readonly string[] }
export interface State { todos: Todo[]; filter: Filter; nextId: number }
export type Action =
  | { type: 'add'; title: string; tags?: string[] }
  | { type: 'toggle'; id: number }
  | { type: 'remove'; id: number }
  | { type: 'filter'; filter: Filter };
