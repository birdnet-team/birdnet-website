module.exports = function (eleventyConfig) {
  // Copy static assets
  eleventyConfig.addPassthroughCopy({ "public": "/" });

  // Ensure GitHub Pages doesn’t run Jekyll
  eleventyConfig.addPassthroughCopy({ "src/.nojekyll": ".nojekyll" });

  // Shortcode for current year
  eleventyConfig.addShortcode("year", () => new Date().getFullYear());

  return {
    dir: { input: "src", includes: "_includes", output: "_site" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["md", "njk", "html"],
    pathPrefix: "/birdnet-website/"
  };
};
