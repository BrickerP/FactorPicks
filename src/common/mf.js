export const MFDataTemplate = {
  weights: [
    {
      name: "E/P_w",
      display_name: "E/P weight",
      val: "1.0"
    },
    {
      name: "B/P_w",
      display_name: "B/P weight",
      val: "1.0"
    },
    {
      name: "S/P_w",
      display_name: "S/P weight",
      val: "1.0"
    },
    {
      name: "FCF/P_w",
      display_name: "FCF/P weight",
      val: "0.5"
    },
    {
      name: "FCFF/EV_w",
      display_name: "FCFF/EV weight",
      val: "0"
    },
    {
      name: "PEG_w",
      display_name: "PEG weight",
      val: "0"
    },
    {
      name: "ROA_w",
      display_name: "ROA weight",
      val: "1.0"
    },
    {
      name: "ROE_w",
      display_name: "ROE weight",
      val: "1.0"
    },
    {
      name: "ROI_w",
      display_name: "ROI weight",
      val: "1.0"
    },
    {
      name: "DIV_w",
      display_name: "Dividend % weight",
      val: "0.5"
    },
    {
      name: "InsiderOwn_w",
      display_name: "Insider Own weight",
      val: "0.2"
    },
    {
      name: "InsiderTrans_w",
      display_name: "Insider Trans weight",
      val: "0.2"
    },
    {
      name: "InstOwn_w",
      display_name: "Inst Own weight",
      val: "0.2"
    },
    {
      name: "InstTrans_w",
      display_name: "Inst Trans weight",
      val: "0.2"
    },
    {
      name: "TgtPrice_w",
      display_name: "Target Price weight",
      val: "0.5"
    },
    {
      name: "ShortFloat_w",
      display_name: "Short Float weight",
      val: "0"
    },
    {
      name: "ShortRatio_w",
      display_name: "Short Ratio weight",
      val: "0"
    },
    {
      name: "E_Q/P_w",
      display_name: "E/P (Last Q) weight",
      val: "1.0"
    },
    {
      name: "Range52W_w",
      display_name: "52W Range weight",
      val: "0.2"
    },
    {
      name: "ShareOutstandingHalfYear_w",
      display_name: "Share Change(6M) weight",
      val: "0"
    },
    {
      name: "ShareOutstandingOneYear_w",
      display_name: "Share Change(1Y) weight",
      val: "0"
    } 
  ]      
}

export const MFUrl = "https://project.zmcx16.moe/?page=investment-formula"
export const MFNote = `Ranked the stocks by multiple factors simulatneously:
Value factor:  Earnings / Price, Book / Price, Sales / Price, FCFF/EV, PEG
Growth factor: ROE, ROA, ROI
Other factor:  Dividend (%), Insider ownership, Insider transcations,
               Institution ownership, Institution transcations
               Difference Target Price and Current Price
Tip: to rank by FCFF/EV + ROE + PEG, set those three weights to 1.0 and all others to 0.
     (lower PEG is better; higher FCFF/EV and ROE are better — all handled automatically)
`