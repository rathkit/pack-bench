// A Vue 3 app written with render functions (no single-file components, so no compiler plugin is needed), rendered on the server.
import { createSSRApp, defineComponent, h, ref, computed, provide, inject, reactive } from 'vue';
import { renderToString } from 'vue/server-renderer';

const key = Symbol('store');
const Item = defineComponent({
  props: { todo: { type: Object, required: true } },
  setup(props) {
    const store = inject(key);
    return () => h('li', { class: props.todo.done ? 'done' : 'open', onClick: () => store.toggle(props.todo.id) }, [h('span', props.todo.title), ...props.todo.tags.map((t) => h('em', { key: t }, '#' + t))]);
  },
});
const List = defineComponent({
  setup() {
    const store = inject(key);
    const shown = computed(() => store.todos.filter((t) => store.filter === 'all' || (store.filter === 'done') === t.done));
    return () => h('ul', shown.value.map((todo) => h(Item, { key: todo.id, todo })));
  },
});
const Filters = defineComponent({
  setup() {
    const store = inject(key);
    return () => h('nav', ['all', 'open', 'done'].map((f) => h('button', { key: f, 'aria-pressed': store.filter === f, onClick: () => (store.filter = f) }, f)));
  },
});
const Stats = defineComponent({
  setup() {
    const store = inject(key);
    const done = computed(() => store.todos.filter((t) => t.done).length);
    return () => h('p', `${done.value} of ${store.todos.length} done`);
  },
});
const App = defineComponent({
  setup() {
    const title = ref('Todos');
    provide(key, reactive({
      filter: 'all',
      todos: [
        { id: 1, title: 'write the benchmark', done: true, tags: ['work'] },
        { id: 2, title: 'run it twice', done: false, tags: ['work', 'later'] },
        { id: 3, title: 'read the output', done: false, tags: [] },
      ],
      toggle(id) { const t = this.todos.find((x) => x.id === id); if (t) t.done = !t.done; },
    }));
    return () => h('main', [h('h1', title.value), h(Filters), h(List), h(Stats)]);
  },
});
renderToString(createSSRApp(App)).then((html) => console.log(html));
