module.exports = {
  pathPrefix: `/Norn-StockScreener`,
  siteMetadata: {
    title: `Norn-StockScreener`,
    description: `scan and filter instruments based on market cap, dividend yield, ROE and popular investment master's stock tactics to find valuable stocks.`,
    author: `@zmcx16`,
    siteUrl: `https://norn-stockscreener.zmcx16.moe`
  },
  plugins: [
    `gatsby-plugin-react-helmet`,
    {
      resolve: `gatsby-source-filesystem`,
      options: {
        name: `images`,
        path: `${__dirname}/src/images`,
      },
    },
    `gatsby-plugin-material-ui`,
    {
      resolve: `gatsby-plugin-manifest`,
      options: {
        name: `Norn-StockScreener`,
        description: `Filter, shortlist stock from the market.`,
        short_name: `Norn-Screener`,
        start_url: `/`,
        background_color: `#1a3664`,
        theme_color: `#1a3664`,
        display: `standalone`,
        icon: `src/images/norn-icon.png`, // This path is relative to the root of the site.
        icon_options: {
          // For all the options available,
          // please see the section "Additional Resources" below.
          // purpose: `any maskable`,
          purpose: `any`,
        },
      },
    },
    // this (optional) plugin enables Progressive Web App + Offline functionality
    // To learn more, visit: https://gatsby.dev/offline
    `gatsby-plugin-offline`,
    `gatsby-plugin-sass`,
  ],
}
