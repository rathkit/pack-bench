<script>
  import Item from './Item.svelte';
  import Stats from './Stats.svelte';
  import Filters from './Filters.svelte';

  let filter = $state('all');
  const todos = $state([
    { id: 1, title: 'write the benchmark', done: true, tags: ['work'] },
    { id: 2, title: 'run it twice', done: false, tags: ['work', 'later'] },
    { id: 3, title: 'read the output', done: false, tags: [] },
  ]);
  const shown = $derived(todos.filter((t) => filter === 'all' || (filter === 'done') === t.done));
</script>

<main>
  <h1>Todos</h1>
  <Filters {filter} onpick={(f) => (filter = f)} />
  <ul>
    {#each shown as todo (todo.id)}
      <Item {todo} />
    {:else}
      <li>nothing to show</li>
    {/each}
  </ul>
  <Stats {todos} />
</main>
