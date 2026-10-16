<script lang="ts">
  import Logo from "./Logo.svelte";

  let { error = "" }: { error?: string } = $props();
</script>

<div class="min-h-screen flex items-center justify-center px-5">
  <div class="w-full max-w-sm text-center">
    <div class="flex items-center justify-center gap-2 font-semibold tracking-tight text-2xl mb-2">
      <Logo class="w-7 h-7 text-amber-400" />
      Specola
    </div>
    <p class="text-white/50 mb-8">Sign in to see your pages.</p>
    <a
      href="/auth/login"
      class="block w-full px-4 py-2.5 rounded-md bg-amber-500 text-black font-medium hover:bg-amber-400"
    >
      Sign in
    </a>
    {#if error}<p class="text-red-400 text-sm mt-4">{error}</p>{/if}
  </div>
</div>
