// A Solid app written without JSX (so no compiler plugin is needed): signals, memos and the server renderer's template helpers.
import { createSignal, createMemo, createRoot, For, Show } from 'solid-js';
import { createStore } from 'solid-js/store';
import { renderToString, ssr, ssrElement, escape, createComponent } from 'solid-js/web';

const todos = [
  { id: 1, title: 'write the benchmark', done: true, tags: ['work'] },
  { id: 2, title: 'run it twice', done: false, tags: ['work', 'later'] },
  { id: 3, title: 'read the output', done: false, tags: [] },
];
function Item(props) {
  return ssr(['<li class="', '">', '', '</li>'], props.todo.done ? 'done' : 'open', escape(props.todo.title), props.todo.tags.map((t) => ssr(['<em>#', '</em>'], escape(t))));
}
function Stats(props) {
  const done = createMemo(() => props.state.todos.filter((t) => t.done).length);
  return ssr(['<p>', ' of ', ' done</p>'], done(), props.state.todos.length);
}
function App() {
  const [state] = createStore({ todos, filter: 'all' });
  const [title] = createSignal('Todos');
  const shown = createMemo(() => state.todos.filter((t) => state.filter === 'all' || (state.filter === 'done') === t.done));
  return ssrElement('main', {}, () => [
    ssr(['<h1>', '</h1>'], escape(title())),
    ssr(['<ul>', '</ul>'], createComponent(For, { each: shown(), children: (todo) => createComponent(Item, { todo }) })),
    createComponent(Show, { when: state.todos.length, get children() { return createComponent(Stats, { state }); } }),
  ], false);
}
console.log(createRoot(() => renderToString(() => createComponent(App, {}))));
