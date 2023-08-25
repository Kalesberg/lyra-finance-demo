import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import chai, { expect } from 'chai';
import { solidity } from 'ethereum-waffle';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';
import { lyraConstants, lyraEvm, lyraUtils, TestSystem, TestSystemContractsType } from '@lyrafinance/protocol';
import { Strategy } from '../typechain-types';

chai.use(solidity);

describe("Options Market", function () {
  let strategy: Strategy;
  let account: SignerWithAddress;
  let testSystem: TestSystemContractsType;

  let boardIds: BigNumber[];
  let strikeIds: BigNumber[];

  let snap: number;

  before(async () => {
    [account] = await ethers.getSigners();
    const enableTracer = false;
    testSystem = await TestSystem.deploy(account, enableTracer);
    await TestSystem.seed(account, testSystem);

    strategy = (await (await ethers.getContractFactory('Strategy', {
      libraries: {
        BlackScholes: testSystem.blackScholes.address,
      }
    })).deploy()) as Strategy;
    await strategy.initAdapter(
      testSystem.lyraRegistry.address,
      testSystem.optionMarket.address,
      testSystem.testCurve.address,
      testSystem.basicFeeCounter.address
    );
  });

  beforeEach(async () => {
    snap = await lyraEvm.takeSnapshot();
  });

  afterEach(async () => {
    await lyraEvm.restoreSnapshot(snap);
  });

  it('Pay out long call', async () => {
    boardIds = await testSystem.optionMarket.getLiveBoards();
    strikeIds = await testSystem.optionMarket.getBoardStrikes(boardIds[0]);
    const strike = await testSystem.optionMarket.getStrike(strikeIds[0]);
    expect(strike.strikePrice).eq(lyraUtils.toBN('1500'));

    // One long call
    await testSystem.optionMarket.openPosition({
      strikeId: strikeIds[0],
      positionId: 0,
      amount: lyraUtils.toBN('1'),
      setCollateralTo: 0,
      iterations: 1,
      minTotalCost: 0,
      maxTotalCost: lyraConstants.MAX_UINT,
      optionType: TestSystem.OptionType.LONG_CALL,
    });

    await lyraEvm.fastForward(lyraConstants.MONTH_SEC);
    await testSystem.snx.exchangeRates.setRateAndInvalid(lyraUtils.toBytes32('sETH'), lyraUtils.toBN('2000'), false);

    await testSystem.optionMarket.settleExpiredBoard(boardIds[0]);
    expect(await testSystem.liquidityPool.totalOutstandingSettlements()).to.eq(lyraUtils.toBN('500'));

    const preBalance = await testSystem.snx.quoteAsset.balanceOf(account.address);
    await testSystem.shortCollateral.settleOptions([strikeIds[0]]);
    const postBalance = await testSystem.snx.quoteAsset.balanceOf(account.address);

    expect(postBalance.sub(preBalance)).to.eq(lyraUtils.toBN('500'));
  });

  it('Buy straddle', async () => {
    const tradeSize = lyraUtils.toBN('3');
    boardIds = await testSystem.optionMarket.getLiveBoards();
    strikeIds = await testSystem.optionMarket.getBoardStrikes(boardIds[0]);
    const strike = await testSystem.optionMarket.getStrike(strikeIds[0]);
    expect(strike.strikePrice).eq(lyraUtils.toBN('1500'));

    await expect(strategy.buyStraddle(strike.id, tradeSize)).to.be.revertedWith("ERC20: transfer amount exceeds allowance");

    await testSystem.snx.quoteAsset.approve(strategy.address, ethers.constants.MaxUint256);
    await (await strategy.buyStraddle(strike.id, tradeSize)).wait();

    const positions = await strategy.getPositions(account.address);
    expect(positions.length).eq(2);
    expect(positions[0].positionId.gt(0)).to.be.true;
    expect(positions[0].strikeId.eq(strike.id)).to.be.true;
    expect(positions[0].amount.eq(tradeSize)).to.be.true;
    expect(positions[0].optionType).eq(0);  // LONG_CALL
    expect(positions[1].positionId.gt(0)).to.be.true;
    expect(positions[1].strikeId.eq(strike.id)).to.be.true;
    expect(positions[1].amount.eq(tradeSize)).to.be.true;
    expect(positions[1].optionType).eq(1);  // LONG_PUT
  })
});
