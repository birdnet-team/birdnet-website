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
