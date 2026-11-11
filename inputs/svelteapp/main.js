// The Svelte components in this folder are compiled to server code by generate.mjs (svelte/compiler) when the image is built;
// the compiled files are the input of the benchmark, so the compiler's own time is not measured.
import { render } from 'svelte/server';
import App from '../generated/svelteapp/App.js';

console.log(render(App, {}).body);
