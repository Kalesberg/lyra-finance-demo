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
    /*
      call premium: "313626400881826666437"
                    "335147793099570123193"
      put premium: "65870633202943297937"
    */
    const tradeSize = lyraUtils.toBN('5');
    boardIds = await testSystem.optionMarket.getLiveBoards();
    strikeIds = await testSystem.optionMarket.getBoardStrikes(boardIds[0]);
    const strike = await testSystem.optionMarket.getStrike(strikeIds[0]);
    expect(strike.strikePrice).eq(lyraUtils.toBN('1500'));

    await expect(strategy.buyStraddle(strike.id, tradeSize)).to.be.revertedWith("ERC20: transfer amount exceeds allowance");

    await testSystem.snx.quoteAsset.approve(strategy.address, ethers.constants.MaxUint256);
    const receipt = await (await strategy.buyStraddle(strike.id, tradeSize)).wait();

    const events = receipt.events?.filter(e => e.event === 'Trade');
    expect(events?.length).to.eq(2);
    expect(events?.[0]?.args?.user).to.eq(account.address);
    expect(events?.[0]?.args?.strikeId).to.eq(strike.id);
    expect(events?.[0]?.args?.positionId.gt(BigNumber.from('0'))).to.be.true;
    expect(events?.[0]?.args?.optionType).to.eq(0); // LONG CALL
    expect(events?.[1]?.args?.user).to.eq(account.address);
    expect(events?.[1]?.args?.strikeId).to.eq(strike.id);
    expect(events?.[1]?.args?.positionId.gt(BigNumber.from('0'))).to.be.true;
    expect(events?.[1]?.args?.optionType).to.eq(1); // LONG PUT
  })
});
