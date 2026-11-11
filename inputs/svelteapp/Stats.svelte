<script>
  let { todos } = $props();
  const done = $derived(todos.filter((t) => t.done).length);
</script>

<p>{done} of {todos.length} done</p>
