module.exports = function (eleventyConfig) {
  // Copy static assets
  eleventyConfig.addPassthroughCopy({ "public": "/" });

  // Ensure GitHub Pages doesn’t run Jekyll
  eleventyConfig.addPassthroughCopy({ "src/.nojekyll": ".nojekyll" });

  // Copy only the Bootstrap files you use
  eleventyConfig.addPassthroughCopy({
    "node_modules/bootstrap/dist/css/bootstrap.min.css": "vendor/bootstrap/bootstrap.min.css",
  });
  eleventyConfig.addPassthroughCopy({
    "node_modules/bootstrap/dist/js/bootstrap.bundle.min.js": "vendor/bootstrap/bootstrap.bundle.min.js",
  });
  eleventyConfig.addPassthroughCopy({
    "node_modules/bootstrap-icons/font/bootstrap-icons.css": "vendor/bootstrap-icons/bootstrap-icons.css",
  });
  eleventyConfig.addPassthroughCopy({
    "node_modules/bootstrap-icons/font/fonts": "vendor/bootstrap-icons/fonts",
  });
  eleventyConfig.addPassthroughCopy({
    "node_modules/@fortawesome/fontawesome-free/css/all.min.css": "vendor/fontawesome/css/all.min.css",
  });
  eleventyConfig.addPassthroughCopy({
    "node_modules/@fortawesome/fontawesome-free/webfonts": "vendor/fontawesome/webfonts",
  });

  // Self-hosted Inter font (SIL OFL 1.1) – no requests to Google Fonts
  eleventyConfig.addPassthroughCopy({
    "node_modules/@fontsource-variable/inter/opsz.css": "vendor/inter/opsz.css",
  });
  eleventyConfig.addPassthroughCopy({
    "node_modules/@fontsource-variable/inter/opsz-italic.css": "vendor/inter/opsz-italic.css",
  });
  eleventyConfig.addPassthroughCopy({
    "node_modules/@fontsource-variable/inter/LICENSE": "vendor/inter/LICENSE",
  });
  eleventyConfig.addPassthroughCopy({
    "node_modules/@fontsource-variable/inter/files/*-opsz-*.woff2": "vendor/inter/files",
  });

  // Self-hosted Leaflet (BSD-2-Clause) for the projects map – no CDN requests
  eleventyConfig.addPassthroughCopy({
    "node_modules/leaflet/dist/leaflet.js": "vendor/leaflet/leaflet.js",
  });
  eleventyConfig.addPassthroughCopy({
    "node_modules/leaflet/dist/leaflet.css": "vendor/leaflet/leaflet.css",
  });
  eleventyConfig.addPassthroughCopy({
    "node_modules/leaflet/dist/images": "vendor/leaflet/images",
  });
  eleventyConfig.addPassthroughCopy({
    "node_modules/leaflet/LICENSE": "vendor/leaflet/LICENSE",
  });

  // Shortcode for current year
  eleventyConfig.addShortcode("year", () => new Date().getFullYear());

  return {
    dir: { input: "src", includes: "_includes", output: "_site" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["md", "njk", "html"],
    //pathPrefix: "/birdnet-website/"
  };
};
