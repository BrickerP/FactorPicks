import React, { useRef, useEffect, createRef, useState } from 'react'
import Grid from '@mui/material/Grid'
import { blue } from '@mui/material/colors'
import Button from '@mui/material/Button'
import SearchIcon from '@mui/icons-material/Search'
import { createTheme } from '@mui/material/styles'
import { ThemeProvider } from '@mui/styles'

import { isMobile } from 'react-device-detect'
import shortid from "shortid"
import { withPrefix } from 'gatsby'

import { StockSectorDict, StockIndustryDict} from '../../common/stockdef'
import { FCDataTemplate } from '../../common/argsList'
import { queryStocks } from '../../common/queryStocks'
import { WATCHLIST } from '../../common/watchlist'
import FilterCriteria from './filterCriteria'
import ModalWindow from '../modalWindow'
import MultiFactor from './multiFactor'
import FilterSectorsIndustries from './filterSectorsIndustries'

import filterContainerStyle from './filterContainer.module.scss'

const customTheme = createTheme({
  palette: {
    import: { 
      backgroundColor: '#43a047', color: '#fff'
    },
    export: { 
      backgroundColor: '#00a152', color: '#fff'
    }
  },
})

const getCurrentSetting = (filterCriteriaListRef, multiFactorRef, filterSectorsIndustriesRef)=>{

  let queryData = { data: { baseArg: [], advArg: [], NornMinehunter: {}, Factor_Intersectional_v1: {}, sector_industries: {} } }

  // get basic arg
  FCDataTemplate.forEach((value, index) => {
    const criteria = filterCriteriaListRef.current[index] && filterCriteriaListRef.current[index].current
    // skip filters whose component is not mounted (collapsed behind "Show All Filters")
    if (!criteria || typeof criteria.getValue !== 'function') return
    let argVal = criteria.getValue()
    if (argVal.type === 0){
      queryData.data.baseArg.push(argVal)
    } else if (argVal.type === 1) {
      queryData.data.advArg.push(argVal)
    }
  })

  if (multiFactorRef.current && typeof multiFactorRef.current.getValue === 'function') {
    queryData.data.Factor_Intersectional_v1 = multiFactorRef.current.getValue()
  }
  if (filterSectorsIndustriesRef.current && typeof filterSectorsIndustriesRef.current.getValue === 'function') {
    queryData.data.sector_industries = filterSectorsIndustriesRef.current.getValue()
  }

  return queryData
}

// split from FilterContainer to prevent rerender FilterContainer
const QueryStocks = ({ queryStocksRef, loadingAnimeRef, filterCriteriaListRef, multiFactorRef, filterSectorsIndustriesRef, ResultTableRef, modalWindowRef, watchlistRef}) => {

  queryStocksRef.current = {
    doQuery: async () => {

      loadingAnimeRef.current.setLoading(true)

      let queryData = getCurrentSetting(filterCriteriaListRef, multiFactorRef, filterSectorsIndustriesRef)
      console.log(queryData)

      try {
        // Load the factor dataset. stat.json lives in static/ and is built by the
        // fetch_stock_data workflow (yfinance -> stat.json).
        const resp = await fetch(withPrefix('stat.json'))
        if (!resp.ok) {
          throw new Error('stat.json fetch failed: ' + resp.status)
        }
        const stockStat = await resp.json()

        let output = queryStocks(stockStat, queryData).map((value, index)=>{
          return {
            id: index,
            symbol: value['symbol'],
            name: value['name'],
            sector: value['sector'] in StockSectorDict ? StockSectorDict[value['sector'].toString()] : StockSectorDict["-1"],
            industry: value['industry'] in StockIndustryDict ? StockIndustryDict[value['industry'].toString()] : StockIndustryDict["-1"],
            marketCap: value['marketCap'],
            PE: value['PE'],
            PEG: value['PEG'],
            FCFFEV: value['FCFFEV'],
            ROE: value['ROE'],
            PB: value['PB'],
            price: value['price'],
            change: value['change'],
            volume: value['volume'],
            beneish_score: value['beneish_score'],
            risk: value['risk'],
            multiFactor: value['multiFactor'],
            tactics: '',
          }
        })

        // watchlist mode: keep only whitelisted symbols
        const wl = watchlistRef.current
        if (wl.mode) {
          output = output.filter(v => wl.symbols.includes(v.symbol))
        }

        ResultTableRef.current.setTable(output)

      } catch (err) {
        console.error(err)
        modalWindowRef.current.popModalWindow(<h2>Query Failed: {String(err && err.message ? err.message : err)}</h2>)
      }

      loadingAnimeRef.current.setLoading(false)
    }
  }

  return (<></>)
}

const FilterContainer = ({ ResultTableRef, loadingAnimeRef }) => {

  // API Definition
  const filterCriteriaListRef = useRef([])
  FCDataTemplate.forEach((value, index) => {
    filterCriteriaListRef.current[index] = createRef()
    filterCriteriaListRef.current[index].current = {
      getValue: null
    }
  })

  const filterSectorsIndustriesRef = useRef({
    getValue: null
  })

  const multiFactorRef = useRef({
    getValue: null
  })

  const queryStocksRef = useRef({
    doQuery: null
  })

  const modalWindowRef = useRef({
    popModalWindow: null
  })

  // watchlist mode: default on, shows only whitelisted companies
  const watchlistRef = useRef({
    mode: true,
    symbols: WATCHLIST,
  })

  // toggle rendered label
  const [watchlistMode, setWatchlistMode] = useState(true)
  const [showAllFilters, setShowAllFilters] = useState(false)


  const importSetting = (e) => {
    Object.entries(e.target.files).forEach(([key, value]) => {
      var reader = new FileReader()
      reader.onload = (function (theFile) {
        return function (e) {
          let data = JSON.parse(e.target.result)

          multiFactorRef.current.setValue(data['data']['Factor_Intersectional_v1'])
          filterSectorsIndustriesRef.current.setValue(data['data']['sector_industries'])

          let argType = ['baseArg', 'advArg']
          argType.forEach((v, i) => {
            if(data['data'][v]){
              data['data'][v].forEach((input_v, input_i) => {
                FCDataTemplate.forEach((template_v, template_i) => {
                  let name = filterCriteriaListRef.current[template_i].current.getValue()['name']
                  if (name === input_v['name']) {
                    filterCriteriaListRef.current[template_i].current.setValue(input_v)
                    return
                  }
                })
              })
            }
          })
          
        }
      })(value)

      reader.readAsBinaryString(value)
      e.target.value = ''
    })
  }

  const exportSetting = (e) => {

    let queryData = getCurrentSetting(filterCriteriaListRef, multiFactorRef, filterSectorsIndustriesRef)

    var aTag = document.createElement('a')
    var blob = new Blob([JSON.stringify(queryData)])
    aTag.download = 'Norn-StockScreener_setting.json'
    aTag.href = URL.createObjectURL(blob)
    aTag.click()
    URL.revokeObjectURL(blob)
  }


  useEffect(() => {
    // componentDidMount is here!
    // componentDidUpdate is here!
    loadingAnimeRef.current.setLoading(false)

    // auto-query the watchlist on first load so the table isn't empty
    const t = setTimeout(() => {
      if (queryStocksRef.current && queryStocksRef.current.doQuery) {
        queryStocksRef.current.doQuery()
      }
    }, 300)

    return () => {
      clearTimeout(t)
    }
  }, [])

  return (
    <>
      <div className={filterContainerStyle.container}>
        <Grid container spacing={1}>
          {
            FCDataTemplate.map((value, index) => {
              // collapse: show only core filters by default, "More Filters" reveals the rest
              if (!showAllFilters && !value.core) return null
              return <FilterCriteria key={shortid.generate()} filterCriteriaRef={filterCriteriaListRef.current[index]} dataTemplate={value} />
            })
          }
        </Grid>
        <div className={filterContainerStyle.cmdPanel}>
          <div></div>
          <Button size="small" onClick={() => setShowAllFilters(!showAllFilters)}>
            {showAllFilters ? 'Hide Advanced Filters' : 'Show All Filters (' + FCDataTemplate.filter(v => !v.core).length + ' more)'}
          </Button>
          <div></div>
        </div>
        <FilterSectorsIndustries filterSectorsIndustriesRef={filterSectorsIndustriesRef} />
        <MultiFactor multiFactorRef={multiFactorRef} onPresetApply={() => {
          if (queryStocksRef.current && typeof queryStocksRef.current.doQuery === 'function') {
            queryStocksRef.current.doQuery()
          }
        }} />
        <ThemeProvider theme={customTheme}>
          <div className={filterContainerStyle.cmdPanel}>
            <div></div>
            <Button variant="contained" component="label" style={customTheme.palette.import}>Import
              <input
                type="file"
                hidden
                onChange={importSetting}
              />
            </Button>
            <div></div>
            <Button variant="contained" style={customTheme.palette.export} onClick={exportSetting}>Export</Button>
            <div></div>
            <Button variant="contained" color="secondary" onClick={() => {
              const next = !watchlistRef.current.mode
              watchlistRef.current.mode = next
              setWatchlistMode(next)
              queryStocksRef.current.doQuery()
            }}>
              {watchlistMode ? 'Watchlist' : 'All Stocks'}
            </Button>
            <ThemeProvider theme={createTheme({ palette: { primary: blue } })}>
              <Button className={filterContainerStyle.queryBtn} variant="contained" color="primary" startIcon={<SearchIcon />} onClick={() => {
                queryStocksRef.current.doQuery()
              }}>{isMobile ? 'Query' : 'Query Now'}</Button>
            </ThemeProvider>
          </div>
        </ThemeProvider>
      </div>
      <ModalWindow modalWindowRef={modalWindowRef} />
      <QueryStocks queryStocksRef={queryStocksRef} loadingAnimeRef={loadingAnimeRef} filterCriteriaListRef={filterCriteriaListRef} ResultTableRef={ResultTableRef} multiFactorRef={multiFactorRef} filterSectorsIndustriesRef={filterSectorsIndustriesRef} modalWindowRef={modalWindowRef} watchlistRef={watchlistRef}/>
    </>
  )
}

export default FilterContainer
