// Applique le thème avant le rendu pour éviter un flash (fichier séparé : CSP sans script inline).
try {
  var t = localStorage.getItem('scenorya:theme');
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.dataset.theme = 'dark';
} catch (e) {}
