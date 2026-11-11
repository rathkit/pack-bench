<script>
  let { filter, onpick = () => {} } = $props();
  const all = ['all', 'open', 'done'];
</script>

<nav>
  {#each all as f (f)}
    <button aria-pressed={filter === f} onclick={() => onpick(f)}>{f}</button>
  {/each}
</nav>
