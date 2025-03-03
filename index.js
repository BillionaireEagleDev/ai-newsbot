const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cheerio = require('cheerio'); // For HTML parsing
const natural = require('natural'); // For text summarization
const app = express();
const port = 3000;

// Configure Express to handle JSON
app.use(express.json());

// Array with your specific RSS feed URLs
const rssFeeds = [
  'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  'https://feeds.bbci.co.uk/news/rss.xml',
  'https://moxie.foxnews.com/google-publisher/latest.xml'
];

// Function to fetch and parse a single RSS feed
async function fetchRSSFeed(url) {
  try {
    const response = await axios.get(url);
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(response.data);
    
    // Extract the items/entries from the feed
    const channel = result.rss?.channel || result.feed;
    const items = channel.item || channel.entry || [];
    
    // Get source name
    const sourceName = channel.title || new URL(url).hostname;
    
    // Normalize to array if single item
    const itemsArray = Array.isArray(items) ? items : [items];
    
    return itemsArray.map(item => {
      // Extract image URL if available
      let imageUrl = null;
      
      // Try different possible image locations in RSS feeds
      if (item.enclosure && item.enclosure.$.type?.startsWith('image/')) {
        imageUrl = item.enclosure.$.url;
      } else if (item['media:content'] && item['media:content'].$.type?.startsWith('image/')) {
        imageUrl = item['media:content'].$.url;
      } else if (item['media:thumbnail']) {
        imageUrl = item['media:thumbnail'].$.url;
      } else if (item.description && item.description.includes('<img')) {
        // Try to extract image from HTML description
        const imgMatch = item.description.match(/<img[^>]+src="([^">]+)"/);
        if (imgMatch) {
          imageUrl = imgMatch[1];
        }
      }
      
      // Extract GUID or create a fallback unique identifier
      let guid = item.guid;
      
      // If guid is an object with _ property (common in some RSS formats)
      if (guid && typeof guid === 'object' && guid._) {
        guid = guid._;
      }
      
      // If no guid exists, try to use other unique identifiers
      if (!guid) {
        guid = item.id || item.link || `${url}-${item.title}-${item.pubDate}`;
      }
      
      // Extract the link
      let link = item.link;
      if (typeof link === 'object') {
        link = link.$ ? link.$.href : '#';
      }
      
      return {
        guid: guid,
        title: item.title || 'No Title',
        description: item.description || item.summary || 'No Description',
        link: link,
        pubDate: item.pubDate || item.published || item.updated || 'No Date',
        imageUrl: imageUrl,
        source: url,
        sourceName: sourceName
      };
    });
  } catch (error) {
    console.error(`Error fetching or parsing RSS feed from ${url}:`, error.message);
    return [];
  }
}

// Function to extract article content using Cheerio
async function extractArticleContent(url) {
  try {
    console.log(`Extracting content from: ${url}`);
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 15000
    });
    
    const html = response.data;
    const $ = cheerio.load(html);
    
    // Remove script tags, style tags, and comments
    $('script, style, meta, link, noscript, iframe, form, header, footer, nav, aside').remove();
    
    // Try various content selectors commonly used in news sites
    let articleContent = '';
    
    // Prioritize article tags, main content divs, and common article content containers
    const possibleSelectors = [
      'article', 
      '[role="main"]',
      'main', 
      '.article-content', 
      '.story-content',
      '.main-content',
      '.post-content',
      '#content-body',
      '.content',
      '.entry-content',
      '.story-body',
      '#article-body'
    ];
    
    let contentElement = null;
    
    // Try each selector until content is found
    for (const selector of possibleSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        contentElement = element;
        break;
      }
    }
    
    // If content container is found, extract all paragraphs
    if (contentElement) {
      const paragraphs = contentElement.find('p');
      const paragraphTexts = [];
      
      paragraphs.each((_, el) => {
        const text = $(el).text().trim();
        if (text && text.length > 20) { // Skip very short paragraphs
          paragraphTexts.push(text);
        }
      });
      
      articleContent = paragraphTexts.join('\n\n');
    }
    
    // If no content found, try extracting all paragraphs in the document
    if (!articleContent || articleContent.length < 200) {
      const paragraphs = $('p');
      const paragraphTexts = [];
      
      paragraphs.each((_, el) => {
        const text = $(el).text().trim();
        if (text && text.length > 20) {
          paragraphTexts.push(text);
        }
      });
      
      // Filter out paragraphs that are likely to be comments, captions, etc.
      const significantParagraphs = paragraphTexts.filter(p => p.length > 30);
      
      if (significantParagraphs.length > 0) {
        articleContent = significantParagraphs.join('\n\n');
      }
    }
    
    if (articleContent && articleContent.length > 150) {
      return articleContent;
    } else {
      // Last resort: try to get any text content with reasonable length
      const bodyText = $('body').text().trim().replace(/\s+/g, ' ');
      if (bodyText.length > 200) {
        return bodyText;
      }
      return `Could not extract meaningful content from ${url}.`;
    }
  } catch (error) {
    console.error(`Error extracting content from ${url}:`, error.message);
    return `Error extracting content: ${error.message}`;
  }
}

// Function to summarize text
function summarizeText(text, minWords = 55, maxWords = 60) {
  try {
    if (!text || text.length < 100) {
      // If text is too short, pad it to reach minimum length if possible
      if (text) {
        const wordCount = text.split(/\s+/).length;
        if (wordCount < minWords) {
          return text + ` ${text.split(/\s+/).slice(0, minWords - wordCount).join(' ')}`;
        }
      }
      return text; // Return original if too short and can't be padded
    }
    
    // Clean the text - remove extra whitespace and common non-content indicators
    text = text.replace(/\s+/g, ' ').trim();
    
    // Use a simple extractive summarization approach
    const tokenizer = new natural.SentenceTokenizer();
    const sentences = tokenizer.tokenize(text);
    
    if (sentences.length <= 3) {
      const words = text.split(/\s+/);
      if (words.length <= maxWords && words.length >= minWords) {
        return text;
      } else if (words.length < minWords) {
        // Repeat some content to reach minimum word count
        return words.concat(words.slice(0, minWords - words.length)).slice(0, maxWords).join(' ');
      }
      return words.slice(0, maxWords).join(' ') + '...';
    }
    
    // Score sentences based on word frequency
    const wordFreq = {};
    const stopwords = [
      'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 
      'in', 'on', 'at', 'to', 'for', 'with', 'by', 'about', 'from', 'of', 
      'that', 'this', 'these', 'those', 'it', 'its'
    ];
    
    // Calculate word frequency
    sentences.forEach(sentence => {
      const words = sentence.toLowerCase().split(/\W+/).filter(word => 
        word.length > 1 && !stopwords.includes(word)
      );
      
      words.forEach(word => {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      });
    });
    
    // Score each sentence
    const sentenceScores = sentences.map(sentence => {
      const words = sentence.toLowerCase().split(/\W+/).filter(word => word.length > 1);
      
      let score = 0;
      words.forEach(word => {
        if (wordFreq[word] && !stopwords.includes(word)) {
          score += wordFreq[word];
        }
      });
      
      // Normalize by sentence length to avoid bias towards longer sentences
      return {
        sentence,
        score: words.length > 0 ? score / words.length : 0,
        wordCount: sentence.split(/\s+/).length
      };
    });
    
    // Sort by score and select top sentences
    const topSentences = sentenceScores
      .sort((a, b) => b.score - a.score)
      .slice(0, 5) // Take top 5 sentences
      .sort((a, b) => sentences.indexOf(a.sentence) - sentences.indexOf(b.sentence)) // Restore original order
      .map(item => item.sentence);
    
    // Create summary and check word count
    let summary = topSentences.join(' ');
    let wordCount = summary.split(/\s+/).length;
    
    if (wordCount > maxWords) {
      // If too long, take just the most important sentences until we approach the limit
      summary = '';
      let currentWords = 0;
      
      for (const sentence of topSentences) {
        const sentenceWordCount = sentence.split(/\s+/).length;
        if (currentWords + sentenceWordCount <= maxWords) {
          summary += sentence + ' ';
          currentWords += sentenceWordCount;
        } else {
          // If we can't fit the current sentence, we'll need to truncate
          if (summary === '' || currentWords < minWords) {
            // Calculate how many words we can take from this sentence
            const wordsNeeded = Math.min(maxWords - currentWords, sentenceWordCount);
            summary += sentence.split(/\s+/).slice(0, wordsNeeded).join(' ') + '... ';
            currentWords += wordsNeeded;
          }
          break;
        }
      }
    }
    
    // Check if we have enough words
    wordCount = summary.trim().split(/\s+/).length;
    
    if (wordCount < minWords) {
      // Not enough words, add more sentences or repeat content
      if (sentences.length > topSentences.length) {
        // Try to add more sentences from our original content
        const additionalSentences = sentenceScores
          .sort((a, b) => b.score - a.score)
          .slice(5, 10)  // Take the next 5 sentences
          .sort((a, b) => sentences.indexOf(a.sentence) - sentences.indexOf(b.sentence));
        
        for (const item of additionalSentences) {
          if (wordCount + item.wordCount <= maxWords) {
            summary += ' ' + item.sentence;
            wordCount += item.wordCount;
            
            if (wordCount >= minWords) {
              break;
            }
          }
        }
      }
      
      // If still below minimum, repeat some key sentences or add general content
      if (wordCount < minWords) {
        // Extract key phrases or repeat information to reach minimum
        const firstSentence = topSentences[0] || "";
        const keyWords = firstSentence.split(/\s+/).slice(0, minWords - wordCount);
        summary += ' Additional context: ' + keyWords.join(' ') + '.';
      }
    }
    
    return summary.trim();
  } catch (error) {
    console.error('Error summarizing text:', error);
    const words = text.split(/\s+/);
    
    // Ensure we have between minWords and maxWords
    if (words.length < minWords) {
      return words.concat(words.slice(0, minWords - words.length)).slice(0, maxWords).join(' ');
    } else {
      return words.slice(0, maxWords).join(' ') + '...'; // Fallback to truncation
    }
  }
}

// Route to fetch, process, and summarize all RSS feeds
app.get('/feeds/all', async (req, res) => {
  try {
    // Fetch all feeds
    const feedPromises = rssFeeds.map(url => fetchRSSFeed(url));
    const feedsResults = await Promise.all(feedPromises);
    
    // Flatten all items
    let allItems = [];
    feedsResults.forEach(feedItems => {
      allItems = allItems.concat(feedItems);
    });
    
    // Sort all items by date (newest first) if possible
    allItems.sort((a, b) => {
      const dateA = new Date(a.pubDate);
      const dateB = new Date(b.pubDate);
      return isNaN(dateA) || isNaN(dateB) ? 0 : dateB - dateA;
    });
    
    // Process items in batches to avoid overwhelming resources
    const batchSize = 3;
    const processedItems = [];
    
    for (let i = 0; i < allItems.length; i += batchSize) {
      const batch = allItems.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i/batchSize) + 1} of ${Math.ceil(allItems.length/batchSize)}`);
      
      const processingPromises = batch.map(async (item) => {
        if (item.link && item.link !== '#') {
          try {
            console.log(`Processing "${item.title}" from: ${item.link}`);
            
            // Extract and summarize content
            const content = await extractArticleContent(item.link);
            const summary = summarizeText(content, 60);
            
            return {
              guid: item.guid,
              title: item.title,
              description: item.description,
              summarized_content: summary,
              imageUrl: item.imageUrl,
              sourceName: item.sourceName,
              pubDate: item.pubDate
            };
          } catch (error) {
            console.error(`Failed to process ${item.link}:`, error);
            return {
              guid: item.guid,
              title: item.title,
              description: item.description,
              summarized_content: summarizeText(item.description || "Summarization failed.", 60),
              imageUrl: item.imageUrl,
              sourceName: item.sourceName,
              pubDate: item.pubDate
            };
          }
        } else {
          return {
            guid: item.guid,
            title: item.title,
            description: item.description,
            summarized_content: summarizeText(item.description || "No content to summarize.", 60),
            imageUrl: item.imageUrl,
            sourceName: item.sourceName,
            pubDate: item.pubDate
          };
        }
      });
      
      const batchResults = await Promise.all(processingPromises);
      processedItems.push(...batchResults);
      
      // Add a delay between batches
      if (i + batchSize < allItems.length) {
        console.log(`Waiting 2 seconds before next batch...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    res.json({
      sources: rssFeeds,
      lastUpdated: new Date().toISOString(),
      items: processedItems
    });
  } catch (error) {
    console.error('Error processing feeds:', error);
    res.status(500).json({ error: 'Failed to process feeds', message: error.message });
  }
});

// Route to get specific item by GUID with automatic processing
app.get('/feeds/item/:guid', async (req, res) => {
  try {
    const { guid } = req.params;
    
    // Fetch all feeds
    const feedPromises = rssFeeds.map(url => fetchRSSFeed(url));
    const feedsResults = await Promise.all(feedPromises);
    
    // Flatten all items
    const allItems = feedsResults.flat();
    
    // Find the item with matching guid
    const item = allItems.find(item => item.guid === guid);
    
    if (item) {
      try {
        if (item.link && item.link !== '#') {
          console.log(`Processing item: ${item.title}`);
          const content = await extractArticleContent(item.link);
          const summary = summarizeText(content, 60);
          
          // Return processed item without storing full content
          res.json({
            guid: item.guid,
            title: item.title,
            description: item.description,
            summarized_content: summary,
            imageUrl: item.imageUrl,
            sourceName: item.sourceName,
            pubDate: item.pubDate
          });
        } else {
          res.json({
            ...item,
            summarized_content: summarizeText(item.description, 60)
          });
        }
      } catch (error) {
        console.error('Error processing item:', error);
        res.json({
          ...item,
          summarized_content: summarizeText(item.description, 60)
        });
      }
    } else {
      res.status(404).json({ error: 'Item not found' });
    }
  } catch (error) {
    console.error('Error fetching item:', error);
    res.status(500).json({ error: 'Failed to fetch item' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`RSS aggregator server running at http://localhost:${port}`);
  console.log(`Access all processed feeds at http://localhost:${port}/feeds/all`);
  console.log(`Access specific processed item by GUID at http://localhost:${port}/feeds/item/:guid`);
});