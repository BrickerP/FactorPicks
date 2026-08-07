import React, { useRef, useEffect, createRef } from 'react'
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
import FilterCriteria from './filterCriteria'
import ModalWindow from '../modalWindow'
import NornMinehunter from './nornMinehunter'
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

const getCurrentSetting = (filterCriteriaListRef, nornMinehunterRef, multiFactorRef, filterSectorsIndustriesRef)=>{

  let queryData = { data: { baseArg: [], advArg: [], NornMinehunter: {}, Factor_Intersectional_v1: {}, sector_industries: {} } }

  // get basic arg
  FCDataTemplate.forEach((value, index) => {
    let argVal = filterCriteriaListRef.current[index].current.getValue()
    if (argVal.type === 0){
      queryData.data.baseArg.push(argVal)
    } else if (argVal.type === 1) {
      queryData.data.advArg.push(argVal)
    }
  })

  queryData.data.NornMinehunter = nornMinehunterRef.current.getValue()
  queryData.data.Factor_Intersectional_v1 = multiFactorRef.current.getValue()
  queryData.data.sector_industries = filterSectorsIndustriesRef.current.getValue()

  return queryData
}

// split from FilterContainer to prevent rerender FilterContainer
const QueryStocks = ({ queryStocksRef, loadingAnimeRef, filterCriteriaListRef, nornMinehunterRef, multiFactorRef, filterSectorsIndustriesRef, ResultTableRef, modalWindowRef}) => {

  queryStocksRef.current = {
    doQuery: async () => {

      loadingAnimeRef.current.setLoading(true)

      let queryData = getCurrentSetting(filterCriteriaListRef, nornMinehunterRef, multiFactorRef, filterSectorsIndustriesRef)
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
            tactics: nornMinehunterRef.current.getEnableTacticStrings(),
          }
        })

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

  const nornMinehunterRef = useRef({
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


  const importSetting = (e) => {
    Object.entries(e.target.files).forEach(([key, value]) => {
      var reader = new FileReader()
      reader.onload = (function (theFile) {
        return function (e) {
          let data = JSON.parse(e.target.result)

          nornMinehunterRef.current.setValue(data['data']['NornMinehunter'])
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

    let queryData = getCurrentSetting(filterCriteriaListRef, nornMinehunterRef, multiFactorRef, filterSectorsIndustriesRef)

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

    return () => {
      // componentWillUnmount is here!
    }
  }, [])

  return (
    <>
      <div className={filterContainerStyle.container}>
        <Grid container spacing={1}>
          {
            FCDataTemplate.map((value, index) => {
              return <FilterCriteria key={shortid.generate()} filterCriteriaRef={filterCriteriaListRef.current[index]} dataTemplate={value} />
            })
          }
        </Grid>
        <FilterSectorsIndustries filterSectorsIndustriesRef={filterSectorsIndustriesRef} />
        <NornMinehunter nornMinehunterRef={nornMinehunterRef}/>
        <MultiFactor multiFactorRef={multiFactorRef} />
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
            <ThemeProvider theme={createTheme({ palette: { primary: blue } })}>
              <Button className={filterContainerStyle.queryBtn} variant="contained" color="primary" startIcon={<SearchIcon />} onClick={() => {
                queryStocksRef.current.doQuery()
              }}>{isMobile ? 'Query' : 'Query Now'}</Button>
            </ThemeProvider>
          </div>
        </ThemeProvider>
      </div>
      <ModalWindow modalWindowRef={modalWindowRef} />
      <QueryStocks queryStocksRef={queryStocksRef} loadingAnimeRef={loadingAnimeRef} filterCriteriaListRef={filterCriteriaListRef} ResultTableRef={ResultTableRef} nornMinehunterRef={nornMinehunterRef} multiFactorRef={multiFactorRef} filterSectorsIndustriesRef={filterSectorsIndustriesRef} modalWindowRef={modalWindowRef}/>
    </>
  )
}

export default FilterContainer
