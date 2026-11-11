<script>
  let { todo } = $props();
</script>

<li class={todo.done ? 'done' : 'open'}>
  <span>{todo.title}</span>
  {#each todo.tags as tag (tag)}
    <em>#{tag}</em>
  {/each}
</li>

<style>
  .done { text-decoration: line-through; }
</style>
