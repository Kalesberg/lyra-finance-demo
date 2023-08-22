//SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@lyrafinance/protocol/contracts/periphery/LyraAdapter.sol";
import {DecimalMath} from "@lyrafinance/protocol/contracts/synthetix/DecimalMath.sol";
import "hardhat/console.sol";

contract Strategy is LyraAdapter {
  using DecimalMath for uint256;

  event Trade(address indexed user, uint256 indexed strikeId, uint256 indexed positionId, OptionType optionType);

  function initAdapter(
    address _lyraRegistry,
    address _optionMarket,
    address _curveSwap,
    address _feeCounter
  ) external onlyOwner {
    // set addresses for LyraAdapter
    setLyraAddresses(_lyraRegistry, _optionMarket, _curveSwap, _feeCounter);
  }

  function buyStraddle(uint256 strikeId, uint256 size) external {
    Strike memory strike = _getStrike(strikeId);
    uint256 callCost = _getPremiumLimit(strike, size, OptionType.LONG_CALL);
    uint256 putCost = _getPremiumLimit(strike, size, OptionType.LONG_PUT);

    quoteAsset.transferFrom(msg.sender, address(this), callCost + putCost);

    TradeResult memory callTrade = _openPosition(
      TradeInputParameters({
        strikeId: strikeId,
        positionId: 0,
        iterations: 1,
        optionType: OptionType.LONG_CALL,
        amount: size,
        setCollateralTo: 0,
        minTotalCost: 0,
        maxTotalCost: callCost,
        rewardRecipient: address(0)
      })
    );
    emit Trade(msg.sender, strikeId, callTrade.positionId, OptionType.LONG_CALL);

    TradeResult memory putTrade = _openPosition(
      TradeInputParameters({
        strikeId: strikeId,
        positionId: 0,
        iterations: 1,
        optionType: OptionType.LONG_PUT,
        amount: size,
        setCollateralTo: 0,
        minTotalCost: 0,
        maxTotalCost: putCost,
        rewardRecipient: address(0)
      })
    );
    emit Trade(msg.sender, strikeId, putTrade.positionId, OptionType.LONG_PUT);

    uint256 leftOver = quoteAsset.balanceOf(address(this));
    if (leftOver > 0) {
      quoteAsset.transfer(msg.sender, leftOver);
    }
  }

  function estimateStraddleCost(uint256 strikeId, uint256 size) public view returns (uint256) {
    (uint256 callPremium, uint256 putPremium) = _getPurePremiumForStrike(strikeId);

    return (callPremium + putPremium).multiplyDecimal(size);
  }

  function _getPremiumLimit(Strike memory strike, uint size, OptionType optionType) internal view returns (uint256) {
    ExchangeRateParams memory exchangeParams = _getExchangeParams();
    (uint callPremium, uint putPremium) = _getPurePremium(
      _getSecondsToExpiry(strike.expiry),
      12e17,
      exchangeParams.spotPrice,
      strike.strikePrice
    );

    return optionType == OptionType.LONG_CALL ? callPremium.multiplyDecimal(size) : putPremium.multiplyDecimal(size);
  }

  function _getStrike(uint256 strikeId) internal view returns (Strike memory) {
    uint256[] memory strikeIds = new uint256[](1);
    strikeIds[0] = strikeId;

    return _getStrikes(strikeIds)[0];
  }

  function _getSecondsToExpiry(uint256 expiry) internal view returns (uint256) {
    return expiry > block.timestamp ? expiry - block.timestamp : 0;
  }
}