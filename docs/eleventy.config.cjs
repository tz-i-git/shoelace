/* eslint-disable no-invalid-this */
const fs = require('fs');
const path = require('path');
const lunr = require('lunr');
const { capitalCase } = require('change-case');
const { JSDOM } = require('jsdom');
const { customElementsManifest, getAllComponents } = require('./_utilities/cem.cjs');
const shoelaceFlavoredMarkdown = require('./_utilities/markdown.cjs');
const activeLinks = require('./_utilities/active-links.cjs');
const anchorHeadings = require('./_utilities/anchor-headings.cjs');
const codePreviews = require('./_utilities/code-previews.cjs');
const copyCodeButtons = require('./_utilities/copy-code-buttons.cjs');
const externalLinks = require('./_utilities/external-links.cjs');
const highlightCodeBlocks = require('./_utilities/highlight-code.cjs');
const tableOfContents = require('./_utilities/table-of-contents.cjs');
const prettier = require('./_utilities/prettier.cjs');
const scrollingTables = require('./_utilities/scrolling-tables.cjs');
const typography = require('./_utilities/typography.cjs');

const assetsDir = 'assets';
const allComponents = getAllComponents();
let hasBuiltSearchIndex = false;

function benchmark (callback) {
  const time = performance.now()
  callback()
  return performance.now() - time
}

module.exports = function (eleventyConfig) {
  //
  // Global data
  //
  eleventyConfig.addGlobalData('baseUrl', 'https://shoelace.style/'); // the production URL
  eleventyConfig.addGlobalData('layout', 'default'); // make 'default' the default layout
  eleventyConfig.addGlobalData('toc', true); // enable the table of contents
  eleventyConfig.addGlobalData('meta', {
    title: 'Shoelace',
    description: 'A forward-thinking library of web components.',
    image: 'images/og-image.png',
    version: customElementsManifest.package.version,
    components: allComponents
  });

  //
  // Layout aliases
  //
  eleventyConfig.addLayoutAlias('default', 'default.njk');

  //
  // Copy assets
  //
  eleventyConfig.addPassthroughCopy(assetsDir);
  eleventyConfig.setServerPassthroughCopyBehavior('passthrough'); // emulates passthrough copy during --serve

  //
  // Functions
  //

  // Generates a URL relative to the site's root
  eleventyConfig.addNunjucksGlobal('rootUrl', (value = '', absolute = false) => {
    value = path.join('/', value);
    return absolute ? new URL(value, eleventyConfig.globalData.baseUrl).toString() : value;
  });

  // Generates a URL relative to the site's asset directory
  eleventyConfig.addNunjucksGlobal('assetUrl', (value = '', absolute = false) => {
    value = path.join(`/${assetsDir}`, value);
    return absolute ? new URL(value, eleventyConfig.globalData.baseUrl).toString() : value;
  });

  // Fetches a specific component's metadata
  eleventyConfig.addNunjucksGlobal('getComponent', tagName => {
    const component = allComponents.find(c => c.tagName === tagName);
    if (!component) {
      throw new Error(
        `Unable to find a component called "${tagName}". Make sure the file name is the same as the component's tag ` +
          `name (minus the sl- prefix).`
      );
    }
    return component;
  });

  //
  // Custom markdown syntaxes
  //
  eleventyConfig.setLibrary('md', shoelaceFlavoredMarkdown);

  //
  // Filters
  //
  eleventyConfig.addFilter('markdown', content => {
    return shoelaceFlavoredMarkdown.render(content);
  });

  eleventyConfig.addFilter('markdownInline', content => {
    return shoelaceFlavoredMarkdown.renderInline(content);
  });

  eleventyConfig.addFilter('classNameToComponentName', className => {
    let name = capitalCase(className.replace(/^Sl/, ''));
    if (name === 'Qr Code') name = 'QR Code'; // manual override
    return name;
  });

  eleventyConfig.addFilter('removeSlPrefix', tagName => {
    return tagName.replace(/^sl-/, '');
  });

  //
  // Transforms
  //

  let transformTimers = {
    activeLinks: 0,
    anchorHeadings: 0,
    tableOfContents: 0,
    codePreviews: 0,
    externalLinks: 0,
    highlightCodeBlock: 0,
    scrollingTables: 0,
    copyCodeButtons: 0,
    typography: 0,
    prettier: 0,
  }
  eleventyConfig.addTransform('html-transform', function (content) {
    // Parse the template and get a Document object
    const doc = new JSDOM(content, {
      // We must set a default URL so links are parsed with a hostname. Let's use a bogus TLD so we can easily
      // identify which ones are internal and which ones are external.
      url: `https://internal/`
    }).window.document;

    // DOM transforms
    transformTimers.activeLinks += benchmark(() => {
      activeLinks(doc, { pathname: this.page.url });
    })

    transformTimers.anchorHeadings += benchmark(() => {
      anchorHeadings(doc, {
        within: '#content .content__body',
        levels: ['h2', 'h3', 'h4', 'h5']
      });
    })

    transformTimers.tableOfContents += benchmark(() => {
      tableOfContents(doc, {
        levels: ['h2', 'h3'],
        container: '#content .content__toc > ul',
        within: '#content .content__body'
      });
    })


    transformTimers.codePreviews += benchmark(() => {
      codePreviews(doc);
    })

    transformTimers.externalLinks += benchmark(() => {
      externalLinks(doc, { target: '_blank' });
    })

    transformTimers.highlightCodeBlock += benchmark(() => {
      highlightCodeBlocks(doc);
    })

    transformTimers.scrollingTables += benchmark(() => {
      scrollingTables(doc);
    })

    transformTimers.copyCodeButtons += benchmark(() => {
      copyCodeButtons(doc); // must be after codePreviews + highlightCodeBlocks
    })

    transformTimers.typography += benchmark(() => {
      typography(doc, '#content');
    })

    // Serialize the Document object to an HTML string and prepend the doctype
    content = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;

    // String transforms
    transformTimers.prettier += benchmark(() => {
      content = prettier(content);
    })

    return content;
  });

  //
  // Build a search index
  //
  eleventyConfig.on('eleventy.after', async ({ results }) => {
    // We only want to build the search index on the first run so all pages get indexed.
    if (hasBuiltSearchIndex) {
      return;
    }

    const map = {};
    const searchIndexFilename = path.join(eleventyConfig.dir.output, assetsDir, 'search.json');
    const lunrFilename = path.join(eleventyConfig.dir.output, assetsDir, 'scripts/lunr.js');
    const searchIndex = lunr(function () {
      // The search index uses these field names extensively, so shortening them can save some serious bytes. The
      // initial index file went from 468 KB => 401 KB by using single-character names!
      this.ref('id'); // id
      this.field('t', { boost: 50 }); // title
      this.field('h', { boost: 25 }); // headings
      this.field('c'); // content

      results.forEach((result, index) => {
        const url = path.join('/', path.relative(eleventyConfig.dir.output, result.outputPath));
        const doc = new JSDOM(result.content, {
          // We must set a default URL so links are parsed with a hostname. Let's use a bogus TLD so we can easily
          // identify which ones are internal and which ones are external.
          url: `https://internal/`
        }).window.document;
        const content = doc.querySelector('#content');

        // Get title and headings
        const title = (doc.querySelector('title')?.textContent || path.basename(result.outputPath)).trim();
        const headings = [...content.querySelectorAll('h1, h2, h3, h4')]
          .map(heading => heading.textContent)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        // Remove code blocks and whitespace from content
        [...content.querySelectorAll('code[class|=language]')].forEach(code => code.remove());
        const textContent = content.textContent.replace(/\s+/g, ' ').trim();

        // Update the index and map
        this.add({ id: index, t: title, h: headings, c: textContent });
        map[index] = { title, url };
      });
    });

    // Copy the Lunr search client and write the index
    fs.copyFileSync('../node_modules/lunr/lunr.min.js', lunrFilename);
    fs.writeFileSync(searchIndexFilename, JSON.stringify({ searchIndex, map }), 'utf-8');

    hasBuiltSearchIndex = true;
    let totalTime = 0
    Object.entries(transformTimers).forEach(([k,v]) => {
      const rounded = Math.ceil(v)
      console.log(k + ": " + rounded + "ms")
      totalTime += rounded
    })
    console.log("Total transform time: " + totalTime + "ms")
  });

  //
  // Dev server options (see https://www.11ty.dev/docs/dev-server/#options)
  //
  eleventyConfig.setServerOptions({
    domDiff: false, // disable dom diffing so custom elements don't break on reload,
    port: 4000, // if port 4000 is taken, 11ty will use the next one available
    watch: [
      "dist/**/*.*"
    ] // additional files to watch that will trigger server updates (array of paths or globs)
  });

  //
  // 11ty config
  //
  return {
    dir: {
      input: 'pages',
      output: '../_site',
      includes: '../_includes' // resolved relative to the input dir
    },
    markdownTemplateEngine: 'njk', // use Nunjucks instead of Liquid for markdown files
    templateEngineOverride: ['njk'] // just Nunjucks and then markdown
  };
};
